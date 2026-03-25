import type { GitHubStatus } from "@superset/local-db";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import {
	LuCheck,
	LuExternalLink,
	LuGitMerge,
	LuGitPullRequest,
	LuLoader,
	LuShieldAlert,
	LuX,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface PRStatusBannerProps {
	pr: NonNullable<GitHubStatus["pr"]>;
	worktreePath: string;
	onRefresh: () => void;
}

type BannerVariant =
	| "ready"
	| "blocked"
	| "failing"
	| "pending"
	| "draft"
	| "merged"
	| "closed";

function getBannerVariant(pr: NonNullable<GitHubStatus["pr"]>): BannerVariant {
	if (pr.state === "merged") return "merged";
	if (pr.state === "closed") return "closed";
	if (pr.state === "draft") return "draft";

	const checks = pr.checks ?? [];
	const hasFailures = checks.some((c) => c.status === "failure");

	if (hasFailures) return "failing";
	if (pr.checksStatus === "pending") return "pending";

	const checksPass =
		pr.checksStatus === "success" || pr.checksStatus === "none";
	if (checksPass && pr.reviewDecision === "approved") return "ready";

	return "blocked";
}

const variantStyles = {
	ready: {
		banner: "bg-emerald-500/10 border-emerald-500/20",
		badge: "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30",
	},
	blocked: {
		banner: "bg-amber-500/10 border-amber-500/20",
		badge: "bg-amber-500/15 text-amber-500 border border-amber-500/30",
	},
	failing: {
		banner: "bg-amber-500/10 border-amber-500/20",
		badge: "bg-amber-500/15 text-amber-500 border border-amber-500/30",
	},
	pending: {
		banner: "bg-muted/50 border-border",
		badge: "bg-muted text-muted-foreground border border-border",
	},
	draft: {
		banner: "bg-muted/50 border-border",
		badge: "bg-muted text-muted-foreground border border-border",
	},
	merged: {
		banner: "bg-violet-500/10 border-violet-500/20",
		badge: "bg-violet-500/15 text-violet-500 border border-violet-500/30",
	},
	closed: {
		banner: "bg-red-500/10 border-red-500/20",
		badge: "bg-red-500/15 text-red-500 border border-red-500/30",
	},
} as const;

function getBannerMessage(
	variant: BannerVariant,
	pr: NonNullable<GitHubStatus["pr"]>,
): string {
	const checks = pr.checks ?? [];
	const relevant = checks.filter(
		(c) => c.status !== "skipped" && c.status !== "cancelled",
	);
	const passing = relevant.filter((c) => c.status === "success").length;
	const failing = relevant.filter((c) => c.status === "failure").length;
	const total = relevant.length;
	const s = total !== 1 ? "s" : "";

	switch (variant) {
		case "ready":
			return "Ready to merge";
		case "failing":
			return `${failing} / ${total} check${s} failed`;
		case "pending":
			return `${passing} / ${total} check${s} passing`;
		case "blocked":
			if (pr.reviewDecision === "changes_requested") return "Changes requested";
			return "Review required";
		case "draft":
			return "Draft";
		case "merged":
			return "Merged";
		case "closed":
			return "Closed";
	}
}

const statusIcons = {
	ready: LuCheck,
	blocked: LuShieldAlert,
	failing: LuX,
	pending: LuLoader,
	draft: LuGitPullRequest,
	merged: LuGitMerge,
	closed: LuX,
};

const statusIconColors = {
	ready: "text-emerald-500",
	blocked: "text-amber-500",
	failing: "text-red-500",
	pending: "text-amber-500 animate-spin",
	draft: "text-muted-foreground",
	merged: "text-violet-500",
	closed: "text-red-500",
};

export function PRStatusBanner({
	pr,
	worktreePath,
	onRefresh,
}: PRStatusBannerProps) {
	const trpcUtils = electronTrpc.useUtils();

	const refreshAll = () => {
		onRefresh();
		trpcUtils.workspaces.getAllPRStatuses.invalidate();
	};

	const mergePRMutation = electronTrpc.changes.mergePR.useMutation({
		onMutate: () => {
			const toastId = toast.loading("Merging PR...");
			return { toastId };
		},
		onSuccess: (_data, _variables, context) => {
			toast.success("PR merged successfully", { id: context?.toastId });
			refreshAll();
		},
		onError: (error, _variables, context) =>
			toast.error(`Merge failed: ${error.message}`, {
				id: context?.toastId,
			}),
	});

	const markReadyMutation = electronTrpc.changes.markPRReady.useMutation({
		onMutate: () => {
			const toastId = toast.loading("Marking as ready for review...");
			return { toastId };
		},
		onSuccess: (_data, _variables, context) => {
			toast.success("PR marked as ready for review", {
				id: context?.toastId,
			});
			refreshAll();
		},
		onError: (error, _variables, context) =>
			toast.error(`Failed: ${error.message}`, { id: context?.toastId }),
	});

	const handleMerge = (strategy: "merge" | "squash" | "rebase") =>
		mergePRMutation.mutate({ worktreePath, strategy });

	const handleMarkReady = () => markReadyMutation.mutate({ worktreePath });

	const variant = getBannerVariant(pr);
	const styles = variantStyles[variant];
	const message = getBannerMessage(variant, pr);
	const StatusIcon = statusIcons[variant];
	const iconColor = statusIconColors[variant];

	return (
		<div
			className={cn(
				"flex items-center gap-2 px-3 py-1.5 border-b text-xs",
				styles.banner,
			)}
		>
			<a
				href={pr.url}
				target="_blank"
				rel="noopener noreferrer"
				className={cn(
					"flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 font-mono hover:opacity-80 transition-opacity",
					styles.badge,
				)}
			>
				<LuGitPullRequest className="size-3" />#{pr.number}
				<LuExternalLink className="size-2.5" />
			</a>

			<span className="flex-1 truncate text-muted-foreground">{message}</span>

			<StatusIcon className={cn("size-3 shrink-0", iconColor)} />

			{variant === "ready" && (
				<button
					type="button"
					onClick={() => handleMerge("squash")}
					className={cn(
						"flex items-center gap-1 shrink-0 rounded px-2 py-1 font-medium transition-colors",
						"bg-emerald-500 text-white hover:bg-emerald-600",
						mergePRMutation.isPending && "opacity-60",
					)}
					disabled={mergePRMutation.isPending}
				>
					{mergePRMutation.isPending ? (
						<LuLoader className="size-3 animate-spin" />
					) : (
						<LuGitMerge className="size-3" />
					)}
					Merge
				</button>
			)}

			{variant === "draft" && (
				<button
					type="button"
					onClick={handleMarkReady}
					className={cn(
						"flex items-center gap-1 shrink-0 rounded px-2 py-1 font-medium transition-colors",
						"bg-foreground text-background hover:bg-foreground/90",
						markReadyMutation.isPending && "opacity-60",
					)}
					disabled={markReadyMutation.isPending}
				>
					{markReadyMutation.isPending ? (
						<LuLoader className="size-3 animate-spin" />
					) : (
						<LuCheck className="size-3" />
					)}
					Ready
				</button>
			)}
		</div>
	);
}
