import picomatch from "picomatch";

import type { AuthorityBinding, ChangedFile, FileMatch } from "./types.js";

export interface BindingMatchResult {
	files: FileMatch[];
	contentMismatches: FileMatch[];
	evaluatedFiles: FileMatch[];
}

function matchingGlob(path: string, includes: string[], excludes: string[]): string | undefined {
	const includedBy = includes.find((glob) => picomatch.isMatch(path, glob, { dot: true }));
	if (!includedBy) {
		return undefined;
	}

	if (excludes.some((glob) => picomatch.isMatch(path, glob, { dot: true }))) {
		return undefined;
	}

	return includedBy;
}

function contentMatches(patch: string, pattern: RegExp): boolean {
	let insideHunk = false;
	for (const line of patch.split(/\r?\n/u)) {
		if (line.startsWith("diff --git ")) {
			insideHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			insideHunk = true;
			continue;
		}
		if (!insideHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) {
			continue;
		}
		if ((line.startsWith("+") || line.startsWith("-")) && pattern.test(line)) {
			return true;
		}
	}
	return false;
}

export function matchBinding(binding: AuthorityBinding, changedFiles: ChangedFile[]): BindingMatchResult {
	const files: FileMatch[] = [];
	const contentMismatches: FileMatch[] = [];
	const evaluatedFiles: FileMatch[] = [];
	const seenFiles = new Set<string>();
	const excludes = binding.exclude ?? [];
	const contentPattern = binding.if_content === undefined ? undefined : new RegExp(binding.if_content);

	for (const changedFile of changedFiles) {
		if (seenFiles.has(changedFile.path)) {
			continue;
		}

		let provenance: { matchedPath: string; matchedGlob: string } | undefined;
		for (const candidate of [changedFile.path, changedFile.oldPath]) {
			if (candidate === undefined) {
				continue;
			}
			const glob = matchingGlob(candidate, binding.paths, excludes);
			if (glob) {
				provenance = { matchedPath: candidate, matchedGlob: glob };
				break;
			}
		}

		if (!provenance) {
			continue;
		}

		let contentCheck: FileMatch["contentCheck"] = "not-configured";
		if (contentPattern) {
			if (changedFile.patch === undefined) {
				contentCheck = "skipped-no-patch";
			} else if (contentMatches(changedFile.patch, contentPattern)) {
				contentCheck = "matched";
			} else {
				contentCheck = "no-match";
			}
		}

		const match: FileMatch = {
			path: changedFile.path,
			status: changedFile.status,
			matchedPath: provenance.matchedPath,
			matchedGlob: provenance.matchedGlob,
			contentCheck,
		};

		seenFiles.add(changedFile.path);
		evaluatedFiles.push(match);
		if (contentCheck === "no-match") {
			contentMismatches.push(match);
		} else {
			files.push(match);
		}
	}

	return { files, contentMismatches, evaluatedFiles };
}
