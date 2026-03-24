import { LuGitBranch } from "react-icons/lu";

interface BranchInfoProps {
	branch: string;
	baseBranch: string;
}

export function BranchInfo({ branch, baseBranch }: BranchInfoProps) {
	return (
		<div className="no-drag flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/60 px-2.5 py-1 rounded">
			<LuGitBranch className="size-3 shrink-0" />
			<span className="truncate max-w-[200px]">{branch}</span>
			<span className="text-muted-foreground/50">&gt;</span>
			<span className="truncate max-w-[120px] text-muted-foreground/70">
				{baseBranch}
			</span>
		</div>
	);
}
