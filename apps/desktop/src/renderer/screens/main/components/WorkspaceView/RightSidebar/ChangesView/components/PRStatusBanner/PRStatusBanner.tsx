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

type BannerVariant = "ready" | "blocked" | "failing" | "pending";

function getBannerVariant(pr: NonNullable<GitHubStatus["pr"]>): BannerVariant {
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
	}
}

export function PRStatusBanner({
	pr,
	worktreePath,
	onRefresh,
}: PRStatusBannerProps) {
	const mergePRMutation = electronTrpc.changes.mergePR.useMutation({
		onMutate: () => {
			const toastId = toast.loading("Merging PR...");
			return { toastId };
		},
		onSuccess: (_data, _variables, context) => {
			toast.success("PR merged successfully", { id: context?.toastId });
			onRefresh();
		},
		onError: (error, _variables, context) =>
			toast.error(`Merge failed: ${error.message}`, {
				id: context?.toastId,
			}),
	});

	const handleMerge = (strategy: "merge" | "squash" | "rebase") =>
		mergePRMutation.mutate({ worktreePath, strategy });

	const variant = getBannerVariant(pr);
	const styles = variantStyles[variant];
	const message = getBannerMessage(variant, pr);

	const StatusIcon = {
		ready: LuCheck,
		blocked: LuShieldAlert,
		failing: LuX,
		pending: LuLoader,
	}[variant];

	const iconColor = {
		ready: "text-emerald-500",
		blocked: "text-amber-500",
		failing: "text-red-500",
		pending: "text-amber-500 animate-spin",
	}[variant];

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
		</div>
	);
}
