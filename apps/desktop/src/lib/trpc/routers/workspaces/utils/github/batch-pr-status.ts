import type { CheckItem, GitHubStatus } from "@superset/local-db";
import { execWithShellEnv } from "../shell-env";
import { extractNwoFromUrl, getRepoContext } from "./repo-context";
import type { RepoContext } from "./types";

interface BatchPRInput {
	workspaceId: string;
	worktreeId: string;
	branch: string;
	worktreePath: string;
}

type PRData = NonNullable<GitHubStatus["pr"]>;

const PR_FIELDS_FRAGMENT = `
      nodes {
        number
        title
        url
        state
        isDraft
        mergedAt
        additions
        deletions
        baseRefName
        headRefName
        headRepository { name }
        headRepositoryOwner { login }
        isCrossRepository
        reviewDecision
        reviewRequests(first: 10) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { slug name }
            }
          }
        }
        reviewThreads(first: 100) {
          nodes {
            isResolved
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    ... on CheckRun {
                      name
                      conclusion
                      detailsUrl
                      startedAt
                      completedAt
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
      }`;

interface RepoGroup {
	owner: string;
	name: string;
	repoContext: RepoContext;
	worktreePath: string;
	branches: Array<{ branch: string; inputs: BatchPRInput[] }>;
}

function buildMultiRepoQuery(groups: RepoGroup[]): string {
	const repoFragments: string[] = [];

	for (let r = 0; r < groups.length; r++) {
		const group = groups[r];
		const branchFragments = group.branches.map((b, i) => {
			const escaped = b.branch.replace(/"/g, '\\"');
			return `pr_${i}: pullRequests(first: 1, headRefName: "${escaped}", states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {${PR_FIELDS_FRAGMENT}
    }`;
		});

		repoFragments.push(
			`repo_${r}: repository(owner: "${group.owner}", name: "${group.name}") {
      ${branchFragments.join("\n      ")}
    }`,
		);
	}

	return `query {
    ${repoFragments.join("\n    ")}
  }`;
}

function mapState(state: string, isDraft: boolean): PRData["state"] {
	if (state === "MERGED") return "merged";
	if (state === "CLOSED") return "closed";
	if (isDraft) return "draft";
	return "open";
}

function mapReviewDecision(
	decision: string | null | undefined,
): PRData["reviewDecision"] {
	if (decision === "APPROVED") return "approved";
	if (decision === "CHANGES_REQUESTED") return "changes_requested";
	return "pending";
}

function parseChecks(
	commitNodes:
		| Array<{
				commit: {
					statusCheckRollup: {
						contexts: { nodes: Array<Record<string, unknown>> };
					} | null;
				};
		  }>
		| undefined,
): { checksStatus: PRData["checksStatus"]; checks: CheckItem[] } {
	const rollupNodes =
		commitNodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;

	if (!rollupNodes || rollupNodes.length === 0) {
		return { checksStatus: "none", checks: [] };
	}

	let hasFailure = false;
	let hasPending = false;
	const checks: CheckItem[] = [];

	for (const ctx of rollupNodes) {
		const name =
			(ctx.name as string) || (ctx.context as string) || "Unknown check";
		const url = (ctx.detailsUrl as string) || (ctx.targetUrl as string);
		const rawStatus = (ctx.state as string) || (ctx.conclusion as string);

		let status: CheckItem["status"];
		if (rawStatus === "SUCCESS") {
			status = "success";
		} else if (
			rawStatus === "FAILURE" ||
			rawStatus === "ERROR" ||
			rawStatus === "TIMED_OUT"
		) {
			status = "failure";
			hasFailure = true;
		} else if (rawStatus === "SKIPPED" || rawStatus === "NEUTRAL") {
			status = "skipped";
		} else if (rawStatus === "CANCELLED") {
			status = "cancelled";
		} else {
			status = "pending";
			hasPending = true;
		}

		checks.push({ name, status, url });
	}

	const checksStatus = hasFailure
		? "failure"
		: hasPending
			? "pending"
			: "success";

	return { checksStatus, checks };
}

function parseReviewRequests(
	reviewRequests:
		| {
				nodes: Array<{
					requestedReviewer: {
						login?: string;
						slug?: string;
						name?: string;
					} | null;
				}>;
		  }
		| undefined,
): string[] {
	if (!reviewRequests?.nodes) return [];
	return reviewRequests.nodes
		.map(
			(r) =>
				r.requestedReviewer?.login ||
				r.requestedReviewer?.slug ||
				r.requestedReviewer?.name ||
				"",
		)
		.filter(Boolean);
}

function countUnresolvedThreads(
	reviewThreads: { nodes: Array<{ isResolved: boolean }> } | undefined,
): number {
	if (!reviewThreads?.nodes) return 0;
	return reviewThreads.nodes.filter((t) => !t.isResolved).length;
}

export interface BatchPRResult {
	status: GitHubStatus;
	unresolvedCommentCount: number;
}

// biome-ignore lint/suspicious/noExplicitAny: GraphQL response is dynamic
function parsePRNode(node: any): {
	pr: PRData;
	unresolvedCommentCount: number;
} {
	return {
		pr: {
			number: node.number,
			title: node.title,
			url: node.url,
			state: mapState(node.state, node.isDraft),
			mergedAt: node.mergedAt ? new Date(node.mergedAt).getTime() : undefined,
			additions: node.additions,
			deletions: node.deletions,
			headRefName: node.headRefName,
			baseRefName: node.baseRefName,
			headRepositoryOwner: node.headRepositoryOwner?.login,
			headRepositoryName: node.headRepository?.name,
			isCrossRepository: node.isCrossRepository,
			reviewDecision: mapReviewDecision(node.reviewDecision),
			...parseChecks(node.commits?.nodes),
			requestedReviewers: parseReviewRequests(node.reviewRequests),
		},
		unresolvedCommentCount: countUnresolvedThreads(node.reviewThreads),
	};
}

export async function fetchAllPRStatuses(
	inputs: BatchPRInput[],
): Promise<Map<string, BatchPRResult>> {
	const results = new Map<string, BatchPRResult>();

	if (inputs.length === 0) return results;

	const repoGroupMap = new Map<string, RepoGroup>();
	const seenPaths = new Map<
		string,
		{ nwo: string; context: RepoContext } | null
	>();

	for (const input of inputs) {
		let resolved = seenPaths.get(input.worktreePath);
		if (resolved === undefined) {
			const ctx = await getRepoContext(input.worktreePath);
			if (ctx) {
				const repoUrl = ctx.isFork ? ctx.upstreamUrl : ctx.repoUrl;
				const nwo = extractNwoFromUrl(repoUrl);
				resolved = nwo ? { nwo, context: ctx } : null;
			} else {
				resolved = null;
			}
			seenPaths.set(input.worktreePath, resolved);
		}

		if (!resolved) {
			results.set(input.workspaceId, {
				status: {
					pr: null,
					repoUrl: "",
					branchExistsOnRemote: false,
					lastRefreshed: Date.now(),
				},
				unresolvedCommentCount: 0,
			});
			continue;
		}

		const { nwo, context } = resolved;
		if (!repoGroupMap.has(nwo)) {
			const [owner, name] = nwo.split("/");
			if (!owner || !name) continue;
			repoGroupMap.set(nwo, {
				owner,
				name,
				repoContext: context,
				worktreePath: input.worktreePath,
				branches: [],
			});
		}

		// biome-ignore lint/style/noNonNullAssertion: set on the line above
		const group = repoGroupMap.get(nwo)!;
		let branchEntry = group.branches.find((b) => b.branch === input.branch);
		if (!branchEntry) {
			branchEntry = { branch: input.branch, inputs: [] };
			group.branches.push(branchEntry);
		}
		branchEntry.inputs.push(input);
	}

	const groups = [...repoGroupMap.values()];
	if (groups.length === 0) return results;

	// Pick any worktree path for gh CLI auth context
	const cwd = groups[0].worktreePath;
	const query = buildMultiRepoQuery(groups);

	let responseData: Record<string, unknown>;
	try {
		const { stdout } = await execWithShellEnv(
			"gh",
			["api", "graphql", "-f", `query=${query}`],
			{
				cwd,
			},
		);
		const parsed = JSON.parse(stdout);
		responseData = parsed?.data ?? {};
	} catch (error) {
		console.warn("[fetchAllPRStatuses] GraphQL query failed:", error);
		return results;
	}

	for (let r = 0; r < groups.length; r++) {
		const group = groups[r];
		const repoAlias = `repo_${r}`;
		// biome-ignore lint/suspicious/noExplicitAny: GraphQL response
		const repoData = responseData[repoAlias] as any;
		if (!repoData) continue;

		const repoUrl = group.repoContext.isFork
			? group.repoContext.upstreamUrl
			: group.repoContext.repoUrl;

		for (let i = 0; i < group.branches.length; i++) {
			const branchEntry = group.branches[i];
			const prAlias = `pr_${i}`;
			const prNodes = repoData[prAlias]?.nodes;
			const parsed =
				prNodes && prNodes.length > 0 ? parsePRNode(prNodes[0]) : null;

			const result: BatchPRResult = {
				status: {
					pr: parsed?.pr ?? null,
					repoUrl,
					upstreamUrl: group.repoContext.upstreamUrl,
					isFork: group.repoContext.isFork,
					branchExistsOnRemote: parsed !== null,
					lastRefreshed: Date.now(),
				},
				unresolvedCommentCount: parsed?.unresolvedCommentCount ?? 0,
			};

			for (const input of branchEntry.inputs) {
				results.set(input.workspaceId, result);
			}
		}
	}

	return results;
}
