import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type ExperienceStatus = "active" | "proposed" | "inactive" | "rejected";
type ScoreOutcome = "success" | "failure" | "partial";

interface Experience {
	id: string;
	text: string;
	tags: string[];
	status: ExperienceStatus;
	score: number;
	uses: number;
	wins: number;
	losses: number;
	partials: number;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
	statsResetAt?: string;
	source?: string;
	notes?: string;
	revisionOf?: string;
}

interface PriorState {
	version: 1;
	enabled: boolean;
	autoCapture: boolean;
	providerDebug: boolean;
	requireReview: boolean;
	maxItems: number;
	maxChars: number;
	maxTraces: number;
	minOverlap: number;
	nextId: number;
	experiences: Experience[];
}

interface TraceToolEvent {
	toolCallId: string;
	toolName: string;
	args: string;
	isError?: boolean;
	result: string;
}

interface TraceTurn {
	turnIndex?: number;
	assistant: string;
	toolResults: string[];
}

interface ProviderRequestDebug {
	at: string;
	model?: string;
	provider?: string;
	api?: string;
	piThinkingLevel?: string;
	payloadModel?: string;
	payloadHasReasoning?: boolean;
	reasoningEffort?: string;
	reasoningSummary?: string;
	payloadHasReasoningEffort?: boolean;
	reasoningEffortLegacy?: string;
	enableThinking?: boolean;
	chatTemplateEnableThinking?: boolean;
	thinkingType?: string;
	thinkingBudgetTokens?: number;
	includeReasoningEncryptedContent?: boolean;
}

interface PriorTrace {
	id: string;
	startedAt: string;
	endedAt?: string;
	cwd: string;
	prompt: string;
	selectedExperienceIds: string[];
	turns: TraceTurn[];
	tools: TraceToolEvent[];
	providerRequests?: ProviderRequestDebug[];
	assistantSummary?: string;
}

interface ScoreRecord {
	id: string;
	traceId: string;
	outcome: ScoreOutcome;
	notes: string;
	selectedExperienceIds: string[];
	createdAt: string;
	traceStartedAt?: string;
}

interface LearnRecord {
	id: string;
	createdAt: string;
	scoreIds: string[];
	traceIds: string[];
	reflectionPath?: string;
	mode?: "reflection" | "manual";
	notes?: string;
}

interface LearningStats {
	scores: number;
	learnedScores: number;
	unlearnedScores: number;
	learnRuns: number;
}

interface TraceStats {
	total: number;
	scored: number;
	unscored: number;
	invalid: number;
}

interface PruneTraceResult extends TraceStats {
	before: number;
	after: number;
	removed: number;
	scoredRemoved: number;
	unscoredRemoved: number;
}

const STATE_DIR = process.env.PI_PRIOR_STATE_DIR ?? join(process.cwd(), ".pi", "prior");
const STATE_PATH = join(STATE_DIR, "prior.json");
const TRACE_PATH = join(STATE_DIR, "traces.jsonl");
const SCORE_PATH = join(STATE_DIR, "scores.jsonl");
const LEARN_PATH = join(STATE_DIR, "learns.jsonl");
const REFLECTION_DIR = join(STATE_DIR, "reflection");

const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_MAX_CHARS = 2_400;
const DEFAULT_MAX_TRACES = 100;
const DEFAULT_MIN_OVERLAP = 0;
const MAX_FIELD_CHARS = 4_000;
const MAX_TRACE_TOOL_ARGS_CHARS = 2_000;
const MAX_TRACE_TOOL_RESULT_CHARS = 2_000;
const MAX_REFLECTION_PACKET_CHARS = 18_000;
const STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"also",
	"and",
	"any",
	"are",
	"because",
	"before",
	"between",
	"but",
	"can",
	"could",
	"for",
	"from",
	"has",
	"have",
	"how",
	"into",
	"its",
	"not",
	"only",
	"our",
	"out",
	"should",
	"that",
	"the",
	"then",
	"there",
	"this",
	"through",
	"use",
	"using",
	"when",
	"where",
	"with",
	"you",
	"your",
]);

let currentTrace: PriorTrace | undefined;
let lastTraceId: string | undefined;

function nowIso(): string {
	return new Date().toISOString();
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function safeStringify(value: unknown): string {
	try {
		const json = JSON.stringify(value, null, 2);
		return typeof json === "string" ? json : String(value);
	} catch (error) {
		return String(value);
	}
}

function redactSecrets(value: string): string {
	return String(value)
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "<redacted private key>")
		.replace(/\b(sk|pk|rk|xox[baprs]?)-[A-Za-z0-9_\-]{16,}\b/g, "$1-<redacted>")
		.replace(
			/(["']?)(\b[A-Za-z0-9_]*?(?:api[_-]?key|token|secret|password|passwd|pwd)\b)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"',}]+)/gi,
			"$2=<redacted>",
		);
}

function trimText(value: unknown, maxChars = MAX_FIELD_CHARS): string {
	const text = redactSecrets(typeof value === "string" ? value : safeStringify(value));
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… <truncated ${text.length - maxChars} chars>`;
}

function sanitizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return [
		...new Set(
			tags
				.filter((tag): tag is string => typeof tag === "string")
				.map((tag) => tag.toLowerCase().replace(/[^a-z0-9_.-]/g, ""))
				.filter(Boolean),
		),
	];
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (!part || typeof part !== "object") return String(part);
				const typed = part as { type?: string; text?: string };
				if (typed.type === "text" && typeof typed.text === "string") return typed.text;
				return `[${typed.type ?? "content"}]`;
			})
			.join("\n");
	}
	return safeStringify(content);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasOwn(record: Record<string, unknown> | undefined, key: string): boolean {
	return Boolean(record && Object.prototype.hasOwnProperty.call(record, key));
}

function debugString(value: unknown, maxChars = 200): string | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return trimText(String(value), maxChars);
	return undefined;
}

function debugBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function debugNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildProviderRequestDebug(
	payload: unknown,
	ctx: { model?: { id?: unknown; provider?: unknown; api?: unknown } },
	piThinkingLevel?: unknown,
): ProviderRequestDebug {
	const payloadRecord = asRecord(payload);
	const reasoning = asRecord(payloadRecord?.reasoning);
	const thinking = asRecord(payloadRecord?.thinking);
	const chatTemplateKwargs = asRecord(payloadRecord?.chat_template_kwargs);
	const include = Array.isArray(payloadRecord?.include) ? payloadRecord.include : [];
	const record: ProviderRequestDebug = {
		at: nowIso(),
		model: debugString(ctx.model?.id),
		provider: debugString(ctx.model?.provider),
		api: debugString(ctx.model?.api),
		piThinkingLevel: debugString(piThinkingLevel),
		payloadModel: debugString(payloadRecord?.model),
		payloadHasReasoning: Boolean(reasoning),
		payloadHasReasoningEffort: hasOwn(payloadRecord, "reasoning_effort"),
		reasoningEffort: debugString(reasoning?.effort),
		reasoningSummary: debugString(reasoning?.summary),
		reasoningEffortLegacy: debugString(payloadRecord?.reasoning_effort),
		enableThinking: debugBoolean(payloadRecord?.enable_thinking),
		chatTemplateEnableThinking: debugBoolean(chatTemplateKwargs?.enable_thinking),
		thinkingType: debugString(thinking?.type),
		thinkingBudgetTokens: debugNumber(thinking?.budget_tokens),
		includeReasoningEncryptedContent: include.includes("reasoning.encrypted_content"),
	};
	return record;
}

function emptyState(): PriorState {
	return {
		version: 1,
		enabled: true,
		autoCapture: true,
		providerDebug: false,
		requireReview: true,
		maxItems: DEFAULT_MAX_ITEMS,
		maxChars: DEFAULT_MAX_CHARS,
		maxTraces: DEFAULT_MAX_TRACES,
		minOverlap: DEFAULT_MIN_OVERLAP,
		nextId: 1,
		experiences: [],
	};
}

function normalizeStatus(value: unknown): ExperienceStatus {
	if (value === "active" || value === "proposed" || value === "inactive" || value === "rejected") return value;
	return "proposed";
}

function normalizeExperience(raw: unknown, fallbackId: string): Experience | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const item = raw as Partial<Experience>;
	const text = typeof item.text === "string" ? item.text.trim() : "";
	if (!text) return undefined;
	const timestamp = nowIso();
	return {
		id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : fallbackId,
		text: trimText(text),
		tags: sanitizeTags(item.tags),
		status: normalizeStatus(item.status),
		score: typeof item.score === "number" && Number.isFinite(item.score) ? Math.max(0, Math.min(1, item.score)) : 0.5,
		uses: typeof item.uses === "number" && Number.isFinite(item.uses) ? Math.max(0, Math.floor(item.uses)) : 0,
		wins: typeof item.wins === "number" && Number.isFinite(item.wins) ? Math.max(0, Math.floor(item.wins)) : 0,
		losses: typeof item.losses === "number" && Number.isFinite(item.losses) ? Math.max(0, Math.floor(item.losses)) : 0,
		partials: typeof item.partials === "number" && Number.isFinite(item.partials) ? Math.max(0, Math.floor(item.partials)) : 0,
		createdAt: typeof item.createdAt === "string" ? item.createdAt : timestamp,
		updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : timestamp,
		lastUsedAt: typeof item.lastUsedAt === "string" ? item.lastUsedAt : undefined,
		statsResetAt: typeof item.statsResetAt === "string" ? item.statsResetAt : undefined,
		source: typeof item.source === "string" ? trimText(item.source, 1_000) : undefined,
		notes: typeof item.notes === "string" ? trimText(item.notes, 2_000) : undefined,
		revisionOf: typeof item.revisionOf === "string" && item.revisionOf.trim() ? item.revisionOf.trim() : undefined,
	};
}

function maxNumericExperienceId(experiences: Experience[]): number {
	return experiences.reduce((max, experience) => {
		const match = experience.id.match(/^P(\d+)$/);
		return match ? Math.max(max, Number(match[1])) : max;
	}, 0);
}

function appendNote(existing: string | undefined, note: string): string {
	return trimText([existing, note].filter(Boolean).join("\n"), 2_000);
}

function repairDuplicateExperienceIds(experiences: Experience[]): void {
	const seen = new Set<string>();
	let nextId = Math.max(1, maxNumericExperienceId(experiences) + 1);
	for (const experience of experiences) {
		const originalId = experience.id;
		if (!seen.has(originalId)) {
			seen.add(originalId);
			continue;
		}
		let repairedId = `P${nextId++}`;
		while (seen.has(repairedId)) repairedId = `P${nextId++}`;
		experience.id = repairedId;
		experience.notes = appendNote(experience.notes, `pi-prior repaired duplicate id ${originalId} to ${repairedId}.`);
		seen.add(repairedId);
	}
}

function normalizeState(raw: unknown): PriorState {
	const fallback = emptyState();
	if (!raw || typeof raw !== "object") return fallback;
	const obj = raw as Partial<PriorState>;
	const experiences = Array.isArray(obj.experiences)
		? obj.experiences
				.map((experience, index) => normalizeExperience(experience, `P${index + 1}`))
				.filter((experience): experience is Experience => experience !== undefined)
		: [];
	repairDuplicateExperienceIds(experiences);
	const maxNumericId = maxNumericExperienceId(experiences);
	return {
		version: 1,
		enabled: typeof obj.enabled === "boolean" ? obj.enabled : fallback.enabled,
		autoCapture: typeof obj.autoCapture === "boolean" ? obj.autoCapture : fallback.autoCapture,
		providerDebug: typeof obj.providerDebug === "boolean" ? obj.providerDebug : fallback.providerDebug,
		requireReview: typeof obj.requireReview === "boolean" ? obj.requireReview : fallback.requireReview,
		maxItems:
			typeof obj.maxItems === "number" && Number.isFinite(obj.maxItems)
				? Math.max(1, Math.floor(obj.maxItems))
				: fallback.maxItems,
		maxChars:
			typeof obj.maxChars === "number" && Number.isFinite(obj.maxChars)
				? Math.max(400, Math.floor(obj.maxChars))
				: fallback.maxChars,
		maxTraces:
			typeof obj.maxTraces === "number" && Number.isFinite(obj.maxTraces)
				? Math.max(1, Math.floor(obj.maxTraces))
				: fallback.maxTraces,
		minOverlap:
			typeof obj.minOverlap === "number" && Number.isFinite(obj.minOverlap)
				? Math.max(0, Math.floor(obj.minOverlap))
				: fallback.minOverlap,
		nextId:
			typeof obj.nextId === "number" && Number.isFinite(obj.nextId)
				? Math.max(Math.floor(obj.nextId), maxNumericId + 1, 1)
				: Math.max(maxNumericId + 1, 1),
		experiences,
	};
}

function loadState(): PriorState {
	if (!existsSync(STATE_PATH)) return emptyState();
	const raw = readFileSync(STATE_PATH, "utf8");
	try {
		return normalizeState(JSON.parse(raw));
	} catch (error) {
		ensureDir(STATE_DIR);
		writeFileSync(join(STATE_DIR, `prior.corrupt.${Date.now()}.json`), raw, "utf8");
		return emptyState();
	}
}

function saveState(state: PriorState): void {
	ensureDir(dirname(STATE_PATH));
	const normalized = normalizeState(state);
	const tmp = `${STATE_PATH}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
	renameSync(tmp, STATE_PATH);
}

function appendJsonl(path: string, value: unknown): void {
	ensureDir(dirname(path));
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonl<T>(path: string, maxLines = 200): T[] {
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines
		.slice(Math.max(0, lines.length - maxLines))
		.map((line) => {
			try {
				return JSON.parse(line) as T;
			} catch (_error) {
				return undefined;
			}
		})
		.filter((line): line is T => line !== undefined);
}

function readJsonlLines(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function traceIdFromLine(line: string): string | undefined {
	try {
		const parsed = JSON.parse(line) as { id?: unknown };
		return typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined;
	} catch (_error) {
		return undefined;
	}
}

function scoredTraceIds(): Set<string> {
	const ids = new Set<string>();
	for (const score of readJsonl<ScoreRecord>(SCORE_PATH, Number.MAX_SAFE_INTEGER)) {
		if (typeof score.traceId === "string" && score.traceId.trim()) ids.add(score.traceId.trim());
	}
	return ids;
}

function readScoreRecords(): ScoreRecord[] {
	return readJsonl<Partial<ScoreRecord>>(SCORE_PATH, Number.MAX_SAFE_INTEGER).filter(
		(score): score is ScoreRecord =>
			typeof score.id === "string" &&
			typeof score.traceId === "string" &&
			(score.outcome === "success" || score.outcome === "failure" || score.outcome === "partial") &&
			Array.isArray(score.selectedExperienceIds),
	);
}

function learnedScoreIds(): Set<string> {
	const ids = new Set<string>();
	for (const record of readJsonl<Partial<LearnRecord>>(LEARN_PATH, Number.MAX_SAFE_INTEGER)) {
		if (!record || !Array.isArray(record.scoreIds)) continue;
		for (const id of record.scoreIds) if (typeof id === "string" && id.trim()) ids.add(id.trim());
	}
	return ids;
}

function unlearnedScoreRecords(count = Number.MAX_SAFE_INTEGER): ScoreRecord[] {
	const keep = Math.max(0, Math.floor(count));
	const learned = learnedScoreIds();
	const unlearned = readScoreRecords().filter((score) => !learned.has(score.id));
	return keep >= unlearned.length ? unlearned : unlearned.slice(-keep);
}

function learningStats(): LearningStats {
	const scores = readScoreRecords();
	const scoreIds = new Set(scores.map((score) => score.id));
	const learned = learnedScoreIds();
	let learnedScores = 0;
	for (const id of scoreIds) if (learned.has(id)) learnedScores += 1;
	const learnRuns = readJsonl<LearnRecord>(LEARN_PATH, Number.MAX_SAFE_INTEGER).length;
	return { scores: scoreIds.size, learnedScores, unlearnedScores: Math.max(0, scoreIds.size - learnedScores), learnRuns };
}

function traceStats(scoredIds = scoredTraceIds()): TraceStats {
	const lines = readJsonlLines(TRACE_PATH);
	let scored = 0;
	let invalid = 0;
	for (const line of lines) {
		const id = traceIdFromLine(line);
		if (!id) invalid += 1;
		if (id && scoredIds.has(id)) scored += 1;
	}
	return { total: lines.length, scored, unscored: lines.length - scored, invalid };
}

function emptyPruneTraceResult(): PruneTraceResult {
	return { before: 0, after: 0, removed: 0, scored: 0, unscored: 0, invalid: 0, scoredRemoved: 0, unscoredRemoved: 0 };
}

function pruneTraceLines(kind: "scored" | "unscored", maxKeep: number): PruneTraceResult {
	const keep = Math.max(0, Math.floor(maxKeep));
	if (!existsSync(TRACE_PATH)) return emptyPruneTraceResult();
	const scoreIds = scoredTraceIds();
	const records = readJsonlLines(TRACE_PATH).map((line, index) => {
		const id = traceIdFromLine(line);
		return { line, index, id, scored: Boolean(id && scoreIds.has(id)), invalid: !id };
	});
	const beforeScored = records.filter((record) => record.scored).length;
	const beforeUnscored = records.length - beforeScored;
	const targets = records.filter((record) => (kind === "scored" ? record.scored : !record.scored));
	const keepTargets = new Set(targets.slice(Math.max(0, targets.length - keep)).map((record) => record.index));
	const kept = records.filter((record) => (kind === "scored" ? !record.scored : record.scored) || keepTargets.has(record.index));
	const removed = records.length - kept.length;
	if (removed > 0) {
		const tmp = `${TRACE_PATH}.tmp`;
		writeFileSync(tmp, kept.length ? `${kept.map((record) => record.line).join("\n")}\n` : "", "utf8");
		renameSync(tmp, TRACE_PATH);
	}
	const scored = kept.filter((record) => record.scored).length;
	const unscored = kept.length - scored;
	return {
		before: records.length,
		after: kept.length,
		removed,
		scored,
		unscored,
		invalid: kept.filter((record) => record.invalid).length,
		scoredRemoved: beforeScored - scored,
		unscoredRemoved: beforeUnscored - unscored,
	};
}

function pruneTraces(maxUnscoredTraces: number): PruneTraceResult {
	return pruneTraceLines("unscored", maxUnscoredTraces);
}

function pruneScoredTraces(maxScoredTraces: number): PruneTraceResult {
	return pruneTraceLines("scored", maxScoredTraces);
}

function parseArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of input.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) args.push(current);
	return args;
}

function restAfterCommand(input: string): string {
	return input.trim().replace(/^\S+\s*/, "").trim();
}

function parseTaggedText(input: string): { text: string; tags: string[] } {
	const tokens = parseArgs(input);
	const tags = tokens
		.filter((token) => token.startsWith("#") && token.length > 1)
		.map((token) => token.slice(1).toLowerCase().replace(/[^a-z0-9_.-]/g, ""))
		.filter(Boolean);
	const text = tokens.filter((token) => !token.startsWith("#")).join(" ").trim();
	return { text, tags: [...new Set(tags)] };
}

function addExperience(
	state: PriorState,
	text: string,
	status: ExperienceStatus,
	tags: string[] = [],
	source?: string,
	notes?: string,
	revisionOf?: string,
): Experience {
	const timestamp = nowIso();
	const experience: Experience = {
		id: `P${state.nextId++}`,
		text: trimText(text.trim()),
		tags: sanitizeTags(tags),
		status,
		score: 0.5,
		uses: 0,
		wins: 0,
		losses: 0,
		partials: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		source: source ? trimText(source, 1_000) : undefined,
		notes: notes ? trimText(notes, 2_000) : undefined,
		revisionOf: revisionOf?.trim() || undefined,
	};
	state.experiences.push(experience);
	return experience;
}

function recalculateScore(experience: Experience): void {
	const scored = experience.wins + experience.losses + experience.partials;
	if (scored === 0) return;
	experience.score = Math.max(0, Math.min(1, (experience.wins + 0.5 * experience.partials) / scored));
	experience.updatedAt = nowIso();
}

function resetExperienceStats(experience: Experience, timestamp = nowIso()): void {
	experience.score = 0.5;
	experience.uses = 0;
	experience.wins = 0;
	experience.losses = 0;
	experience.partials = 0;
	experience.lastUsedAt = undefined;
	experience.statsResetAt = timestamp;
}

function applyRevisionProposal(state: PriorState, proposal: Experience): boolean {
	if (!proposal.revisionOf || proposal.status !== "proposed") return false;
	const target = state.experiences.find((experience) => experience.id === proposal.revisionOf);
	if (!target) return false;
	const timestamp = nowIso();
	const previousStats = `score=${target.score.toFixed(2)} uses=${target.uses} wins=${target.wins} losses=${target.losses} partials=${target.partials}`;
	target.text = proposal.text;
	target.tags = proposal.tags;
	target.source = proposal.source ?? `revision:${proposal.id}`;
	target.notes = trimText(`Revised from proposal ${proposal.id} at ${timestamp}. Previous ${previousStats}.`, 2_000);
	resetExperienceStats(target, timestamp);
	target.updatedAt = timestamp;
	proposal.status = "inactive";
	proposal.notes = trimText(`Applied to ${target.id} at ${timestamp}.`, 2_000);
	proposal.updatedAt = timestamp;
	return true;
}

function activateExperience(state: PriorState, experience: Experience): boolean {
	if (experience.revisionOf) return experience.status === "proposed" ? applyRevisionProposal(state, experience) : false;
	experience.status = "active";
	experience.updatedAt = nowIso();
	return true;
}

function tokens(text: string): Set<string> {
	const result = new Set<string>();
	for (const match of text.toLowerCase().matchAll(/[a-z0-9_][a-z0-9_.-]{2,}/g)) {
		const token = match[0];
		if (!STOPWORDS.has(token)) result.add(token);
	}
	return result;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagMatchesQuery(tag: string, queryLower: string, queryTokens: Set<string>): boolean {
	if (!tag) return false;
	if (queryTokens.has(tag)) return true;
	return new RegExp(`(^|[^a-z0-9_.-])#?${escapeRegExp(tag)}([^a-z0-9_.-]|$)`).test(queryLower);
}

function lexicalMatch(experience: Experience, query: string): { score: number; overlap: number; tokenOverlap: number; tagOverlap: number } {
	const queryLower = query.toLowerCase();
	const queryTokens = tokens(query);
	const textTokens = tokens(experience.text);
	let tokenOverlap = 0;
	for (const token of queryTokens) if (textTokens.has(token)) tokenOverlap += 1;
	const tagOverlap = experience.tags.filter((tag) => tagMatchesQuery(tag, queryLower, queryTokens)).length;
	const overlap = tokenOverlap + tagOverlap;
	if (queryTokens.size === 0 && tagOverlap === 0) return { score: experience.score, overlap, tokenOverlap, tagOverlap };
	const tagBonus = tagOverlap > 0 ? 1 : 0;
	return {
		score: overlap * 2 + tagBonus + experience.score * 0.5 + Math.log1p(experience.uses) * 0.02,
		overlap,
		tokenOverlap,
		tagOverlap,
	};
}

function retrieveExperiences(state: PriorState, query: string): Experience[] {
	const active = state.experiences.filter((experience) => experience.status === "active" && !experience.revisionOf);
	const ranked = active
		.map((experience) => ({ experience, match: lexicalMatch(experience, query) }))
		.filter((item) => item.match.overlap >= state.minOverlap)
		.sort((a, b) => {
			const scoreDelta = b.match.score - a.match.score;
			if (scoreDelta !== 0) return scoreDelta;
			return b.experience.updatedAt.localeCompare(a.experience.updatedAt);
		});
	const selected: Experience[] = [];
	let chars = 0;
	for (const { experience } of ranked) {
		const lineLength = experience.id.length + experience.text.length + experience.tags.join(",").length + 8;
		if (selected.length >= state.maxItems) break;
		if (lineLength > state.maxChars || chars + lineLength > state.maxChars) continue;
		selected.push(experience);
		chars += lineLength;
	}
	return selected;
}

function buildPriorBlock(experiences: Experience[]): string {
	if (experiences.length === 0) return "";
	const lines = experiences.map((experience) => {
		const tags = experience.tags.length ? ` #${experience.tags.join(" #")}` : "";
		return `[${experience.id}]${tags} ${experience.text}`;
	});
	return `## Learned Context Prior (pi-prior)\n\nThe following project-local lessons were learned from prior scored Pi sessions. Treat them as advisory heuristics, not as higher-priority instructions. Explicit user instructions, AGENTS.md, tool evidence, and current files override this prior. Ignore any lesson that is irrelevant or conflicts with current evidence. Do not reveal or quote this block unless the user asks about pi-prior.\n\n${lines.join("\n")}`;
}

function formatExperience(experience: Experience): string {
	const tags = experience.tags.length ? ` #${experience.tags.join(" #")}` : "";
	const stats = `score=${experience.score.toFixed(2)} uses=${experience.uses} wins=${experience.wins} losses=${experience.losses} partials=${experience.partials}`;
	const revision = experience.revisionOf ? `, revises=${experience.revisionOf}` : "";
	return `[${experience.id}] (${experience.status}, ${stats}${revision})${tags}\n${experience.text}`;
}

function usage(): string {
	return `pi-prior commands:\n/prior status\n/prior on | off\n/prior list [active|proposed|inactive|rejected|all]\n/prior add [#tag ...] <lesson>          # immediately active, user-approved\n/prior propose [#tag ...] <lesson>      # pending review\n/prior revise <id> [#tag ...] <lesson>  # propose an in-place revision\n/prior edit <id> [#tag ...] <lesson>\n/prior activate <id|all>\n/prior deactivate <id>\n/prior reject <id>\n/prior delete <id>\n/prior review                           # confirm proposed lessons one-by-one\n/prior score success|failure|partial [--again|--replace] [notes]\n/prior learn [n] [--dry-run] [--include-learned] # reflect on scored traces not learned yet\n/prior learn --mark-existing [n]        # mark existing scored records learned without model turn\n/prior prune [n]                         # preserve scored; keep most recent n unscored traces; default maxTraces\n/prior prune unscored [n]                # explicit form of /prior prune [n]\n/prior prune scored <n>                  # hard-prune scored trace bodies, keeping latest n\n/prior export [path]\n/prior import <path> [merge|replace]\n/prior config maxItems <n> | maxChars <n> | maxTraces <n> | minOverlap <n> | autoCapture on|off | providerDebug on|off\n/prior path`;
}

function summarizeState(state: PriorState): string {
	const counts = state.experiences.reduce<Record<string, number>>((acc, experience) => {
		acc[experience.status] = (acc[experience.status] ?? 0) + 1;
		return acc;
	}, {});
	const stats = traceStats();
	const learning = learningStats();
	return `pi-prior ${state.enabled ? "enabled" : "disabled"}\nactive=${counts.active ?? 0}, proposed=${counts.proposed ?? 0}, inactive=${counts.inactive ?? 0}, rejected=${counts.rejected ?? 0}\nmaxItems=${state.maxItems}, maxChars=${state.maxChars}, maxTraces=${state.maxTraces}, minOverlap=${state.minOverlap}, traces=${stats.total} (unscored=${stats.unscored}/${state.maxTraces}, scored=${stats.scored}), scores=${learning.scores} (unlearned=${learning.unlearnedScores}, learned=${learning.learnedScores}, learnRuns=${learning.learnRuns}), autoCapture=${state.autoCapture}, providerDebug=${state.providerDebug}\nstate=${STATE_PATH}\ntraces=${TRACE_PATH}\nlearns=${LEARN_PATH}`;
}

function findLastTrace(): PriorTrace | undefined {
	const traces = readJsonl<PriorTrace>(TRACE_PATH, 100);
	if (lastTraceId) {
		const match = traces.find((trace) => trace.id === lastTraceId);
		if (match) return match;
	}
	return traces.at(-1);
}

function buildScoreRecord(trace: PriorTrace, outcome: ScoreOutcome, notes: string): ScoreRecord {
	return {
		id: `S${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		traceId: trace.id,
		outcome,
		notes: trimText(notes, 2_000),
		selectedExperienceIds: trace.selectedExperienceIds,
		createdAt: nowIso(),
		traceStartedAt: trace.startedAt,
	};
}

function incrementExperienceFeedback(experience: Experience, outcome: ScoreOutcome): void {
	if (outcome === "success") experience.wins += 1;
	else if (outcome === "failure") experience.losses += 1;
	else experience.partials += 1;
}

function scoreTrace(state: PriorState, trace: PriorTrace, outcome: ScoreOutcome, notes: string): { record: ScoreRecord; updatedCount: number } {
	const record = buildScoreRecord(trace, outcome, notes);
	let updatedCount = 0;
	for (const id of trace.selectedExperienceIds) {
		const experience = state.experiences.find((item) => item.id === id);
		if (!experience || !scoreCountsForExperience(experience, record)) continue;
		incrementExperienceFeedback(experience, outcome);
		recalculateScore(experience);
		updatedCount += 1;
	}
	appendJsonl(SCORE_PATH, record);
	return { record, updatedCount };
}

function writeScoreRecords(records: ScoreRecord[]): void {
	ensureDir(dirname(SCORE_PATH));
	const tmp = `${SCORE_PATH}.tmp`;
	writeFileSync(tmp, records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "", "utf8");
	renameSync(tmp, SCORE_PATH);
}

function scoreFeedbackTime(record: ScoreRecord): string | undefined {
	return record.traceStartedAt || record.createdAt;
}

function scoreCountsForExperience(experience: Experience, record: ScoreRecord): boolean {
	if (!experience.statsResetAt) return true;
	const feedbackTime = scoreFeedbackTime(record);
	return Boolean(feedbackTime && feedbackTime >= experience.statsResetAt);
}

function recomputeExperienceFeedbackFromScores(state: PriorState, records: ScoreRecord[], affectedIds: string[]): number {
	const touched = new Set(affectedIds);
	const timestamp = nowIso();
	let recomputedCount = 0;
	for (const experience of state.experiences) {
		if (!touched.has(experience.id)) continue;
		experience.wins = 0;
		experience.losses = 0;
		experience.partials = 0;
		experience.score = 0.5;
		experience.updatedAt = timestamp;
		recomputedCount += 1;
	}
	for (const record of records) {
		for (const id of record.selectedExperienceIds) {
			if (!touched.has(id)) continue;
			const experience = state.experiences.find((item) => item.id === id);
			if (!experience || !scoreCountsForExperience(experience, record)) continue;
			incrementExperienceFeedback(experience, record.outcome);
		}
	}
	for (const experience of state.experiences) {
		if (!touched.has(experience.id)) continue;
		if (experience.wins + experience.losses + experience.partials > 0) recalculateScore(experience);
	}
	return recomputedCount;
}

function replaceLatestTraceScore(state: PriorState, trace: PriorTrace, outcome: ScoreOutcome, notes: string): { record: ScoreRecord; replaced: ScoreRecord; recomputedCount: number } | undefined {
	const records = readScoreRecords();
	let index = -1;
	for (let i = records.length - 1; i >= 0; i -= 1) {
		if (records[i].traceId === trace.id) {
			index = i;
			break;
		}
	}
	if (index < 0) return undefined;
	const replaced = records[index];
	const record = buildScoreRecord(trace, outcome, notes);
	const affectedIds = [...new Set([...replaced.selectedExperienceIds, ...record.selectedExperienceIds])];
	records[index] = record;
	writeScoreRecords(records);
	const recomputedCount = recomputeExperienceFeedbackFromScores(state, records, affectedIds);
	return { record, replaced, recomputedCount };
}

function buildReflectionPacket(
	count: number,
	includeLearned = false,
): {
	path: string;
	body: string;
	feedbackCount: number;
	missingTraceCount: number;
	skippedLearnedCount: number;
	budgetSkippedCount: number;
	scoreIds: string[];
	traceIds: string[];
} {
	const keep = Math.max(0, Math.floor(count));
	const allScores = readScoreRecords();
	const learned = includeLearned ? new Set<string>() : learnedScoreIds();
	const availableScores = includeLearned ? allScores : allScores.filter((score) => !learned.has(score.id));
	const candidateScores = keep === 0 ? [] : availableScores.slice(-keep);
	const traces = readJsonl<PriorTrace>(TRACE_PATH, Number.MAX_SAFE_INTEGER);
	const byId = new Map(traces.map((trace) => [trace.id, trace]));
	const parts: string[] = [];
	const includedScores: ScoreRecord[] = [];
	let missingTraceCount = 0;
	let budgetSkippedCount = 0;
	const skippedLearnedCount = includeLearned ? 0 : allScores.length - availableScores.length;
	parts.push("# pi-prior reflection packet", "");
	parts.push("Use this packet to propose compact, generalizable lessons for future Pi sessions.", "");
	parts.push(
		"Only scored traces are included. Unscored trace history is ignored except as retained raw trace data for future scoring. By default, score records that already appeared in a /prior learn run are skipped; use /prior learn [n] --include-learned to intentionally revisit them.",
		"",
	);
	parts.push(
		"Selected prior IDs are exactly the lessons that were injected during that run. Do not assume lessons created after a trace were available to that trace; if an old trace has already been reflected into a lesson, avoid re-proposing the same lesson.",
		"",
	);
	const selectionLineIndex = parts.length;
	parts.push(`Learning selection: ${candidateScores.length} score(s), skipped previously learned=${skippedLearnedCount}, skipped due packet budget=0.`, "");
	for (const score of candidateScores) {
		const trace = byId.get(score.traceId);
		const section: string[] = [];
		let sectionMissingTrace = false;
		section.push(`## ${score.outcome.toUpperCase()} ${score.traceId}`);
		section.push(`Score ID: ${score.id}`);
		section.push(`Notes: ${score.notes || "(none)"}`);
		section.push(`Selected prior IDs: ${score.selectedExperienceIds.join(", ") || "(none)"}`);
		if (!trace) {
			sectionMissingTrace = true;
			section.push("Trace: missing");
		} else {
			section.push(`Trace started: ${trace.startedAt}`);
			section.push(`Prompt:\n${trimText(trace.prompt, 1_500)}`);
			if (trace.assistantSummary) section.push(`Assistant summary:\n${trimText(trace.assistantSummary, 1_500)}`);
			if (trace.tools.length) {
				section.push("Tool events:");
				for (const tool of trace.tools.slice(0, 8)) {
					section.push(`- ${tool.toolName} error=${tool.isError ? "yes" : "no"}: ${trimText(tool.result, 600).replace(/\n/g, " ")}`);
				}
			}
		}
		const projected = [...parts, ...section, ""].join("\n");
		if (projected.length > MAX_REFLECTION_PACKET_CHARS) {
			budgetSkippedCount += 1;
			continue;
		}
		parts.push(...section, "");
		includedScores.push(score);
		if (sectionMissingTrace) missingTraceCount += 1;
	}
	parts[selectionLineIndex] = `Learning selection: ${includedScores.length} score(s), skipped previously learned=${skippedLearnedCount}, skipped due packet budget=${budgetSkippedCount}.`;
	if (budgetSkippedCount > 0) {
		const budgetNote = `Budget note: ${budgetSkippedCount} score(s) were left unlearned because the reflection packet reached ${MAX_REFLECTION_PACKET_CHARS} characters. Run /prior learn with a smaller n after this run to process the remainder.`;
		if ([...parts, budgetNote, ""].join("\n").length <= MAX_REFLECTION_PACKET_CHARS) parts.push(budgetNote, "");
	}
	const body = parts.join("\n");
	ensureDir(REFLECTION_DIR);
	const path = join(REFLECTION_DIR, `reflection-${Date.now()}.md`);
	writeFileSync(path, body, "utf8");
	return {
		path,
		body,
		feedbackCount: includedScores.length,
		missingTraceCount,
		skippedLearnedCount,
		budgetSkippedCount,
		scoreIds: includedScores.map((score) => score.id),
		traceIds: includedScores.map((score) => score.traceId),
	};
}

function recordLearnRun(packet: { path: string; scoreIds: string[]; traceIds: string[] }): LearnRecord {
	const record: LearnRecord = {
		id: `L${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		createdAt: nowIso(),
		scoreIds: packet.scoreIds,
		traceIds: packet.traceIds,
		reflectionPath: packet.path,
		mode: "reflection",
	};
	appendJsonl(LEARN_PATH, record);
	return record;
}

function markScoresLearned(count = Number.MAX_SAFE_INTEGER, notes = "manual catch-up"): LearnRecord {
	const scores = unlearnedScoreRecords(count);
	const record: LearnRecord = {
		id: `L${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		createdAt: nowIso(),
		scoreIds: scores.map((score) => score.id),
		traceIds: scores.map((score) => score.traceId),
		mode: "manual",
		notes: trimText(notes, 1_000),
	};
	if (scores.length > 0) appendJsonl(LEARN_PATH, record);
	return record;
}

function buildReflectionPrompt(packet: string): string {
	return `You are updating pi-prior, a project-local learned context prior for Pi.\n\nReview the scored traces below. Propose 3-7 concise, durable lessons or revisions that would have helped successful behavior or prevented failures. Good lessons are project/tool/process specific, falsifiable, and short. Avoid secrets, paths that are not generally useful, one-off facts, and instructions that conflict with AGENTS.md or user instructions.\n\nPrefer revising an existing lesson when a scored trace shows that lesson is wrong, stale, too broad, or misleading; avoid adding a near-duplicate on top. Selected prior IDs in the packet are the lessons that were actually injected at trace time, so do not fault an old trace for failing to use a lesson that was derived later. For a new lesson, call the \`pi_prior\` tool with action=\"propose\", a short \`text\`, and optional \`tags\`. For a revision, call \`pi_prior\` with action=\"revise\", the target \`id\`, replacement \`text\`, and optional \`tags\`. You may use action=\"list\" or action=\"retrieve\" first to inspect current lessons. Do not activate, delete, or directly rewrite existing lessons; humans will review proposed lessons/revisions with /prior review or /prior activate.\n\n${packet}`;
}

function dimStatusText(ctx: { ui?: { theme?: { fg?: (color: string, text: string) => string } } } | undefined, text: string): string {
	try {
		return ctx?.ui?.theme?.fg?.("dim", text) ?? text;
	} catch (_error) {
		return text;
	}
}

function setStatus(ctx?: { ui?: { setStatus?: (key: string, value: string) => void; theme?: { fg?: (color: string, text: string) => string } } }, state = loadState()): void {
	const active = state.experiences.filter((experience) => experience.status === "active").length;
	const proposed = state.experiences.filter((experience) => experience.status === "proposed").length;
	const stats = traceStats();
	const prior = state.enabled ? `prior ${active}${proposed ? `/${proposed}p` : ""}` : "prior off";
	ctx?.ui?.setStatus?.("pi-prior", dimStatusText(ctx, `${prior} u${stats.unscored}/${state.maxTraces} s${stats.scored}`));
}

const PiPriorParams = Type.Object({
	action: StringEnum(["list", "retrieve", "propose", "revise"] as const),
	query: Type.Optional(Type.String({ description: "Retrieval query for active experiences." })),
	status: Type.Optional(StringEnum(["active", "proposed", "inactive", "rejected", "all"] as const)),
	id: Type.Optional(Type.String({ description: "Existing lesson ID to revise. Required for action=revise." })),
	text: Type.Optional(Type.String({ description: "Lesson text to propose or replacement text for action=revise." })),
	tags: Type.Optional(Type.Array(Type.String({ description: "Short lowercase tags." }))),
	sourceNote: Type.Optional(Type.String({ description: "Why this lesson or revision is being proposed." })),
});

export default function piPrior(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		setStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const state = loadState();
		const selected = state.enabled ? retrieveExperiences(state, event.prompt ?? "") : [];
		if (state.autoCapture) {
			currentTrace = {
				id: `T${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				startedAt: nowIso(),
				cwd: process.cwd(),
				prompt: trimText(event.prompt ?? "", 4_000),
				selectedExperienceIds: selected.map((experience) => experience.id),
				turns: [],
				tools: [],
				providerRequests: state.providerDebug ? [] : undefined,
			};
		}
		if (!state.enabled || selected.length === 0) return;
		const timestamp = nowIso();
		for (const experience of selected) {
			experience.uses += 1;
			experience.lastUsedAt = timestamp;
		}
		saveState(state);
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPriorBlock(selected)}` };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!currentTrace) return;
		const state = loadState();
		if (!state.providerDebug) return;
		const piWithThinking = pi as ExtensionAPI & { getThinkingLevel?: () => unknown };
		const piThinkingLevel = typeof piWithThinking.getThinkingLevel === "function" ? piWithThinking.getThinkingLevel() : undefined;
		currentTrace.providerRequests ??= [];
		currentTrace.providerRequests.push(buildProviderRequestDebug(event.payload, ctx, piThinkingLevel));
	});

	pi.on("tool_execution_end", async (event) => {
		if (!currentTrace) return;
		currentTrace.tools.push({
			toolCallId: String(event.toolCallId),
			toolName: String(event.toolName),
			args: trimText(event.args, MAX_TRACE_TOOL_ARGS_CHARS),
			isError: Boolean(event.isError),
			result: trimText(event.result, MAX_TRACE_TOOL_RESULT_CHARS),
		});
	});

	pi.on("turn_end", async (event) => {
		if (!currentTrace) return;
		currentTrace.turns.push({
			turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : undefined,
			assistant: trimText(contentToText(event.message?.content), 2_000),
			toolResults: Array.isArray(event.toolResults)
				? event.toolResults.map((result) => trimText(result, 1_000)).slice(0, 10)
				: [],
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!currentTrace) return;
		currentTrace.endedAt = nowIso();
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
		if (lastAssistant) currentTrace.assistantSummary = trimText(contentToText(lastAssistant.content), 3_000);
		appendJsonl(TRACE_PATH, currentTrace);
		const state = loadState();
		pruneTraces(state.maxTraces);
		lastTraceId = currentTrace.id;
		currentTrace = undefined;
		setStatus(ctx, state);
	});

	pi.registerTool({
		name: "pi_prior",
		label: "Pi Prior",
		description: "List, retrieve, propose, or propose revisions to project-local learned context-prior lessons. Proposed lessons/revisions require human activation before injection or application.",
		promptGuidelines: [
			"Use pi_prior action=propose or action=revise only when explicitly asked to update the learned prior from scored traces.",
			"Prefer action=revise over action=propose when an existing lesson should be corrected instead of duplicated.",
			"Do not store secrets, one-off facts, or instructions that conflict with the user, AGENTS.md, or current tool evidence.",
		],
		parameters: PiPriorParams,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState();
			if (params.action === "retrieve") {
				const selected = retrieveExperiences(state, params.query ?? "");
				return {
					content: [{ type: "text", text: selected.length ? selected.map(formatExperience).join("\n\n") : "No active matching experiences." }],
					details: { action: "retrieve", ids: selected.map((experience) => experience.id) },
				};
			}
			if (params.action === "list") {
				const status = params.status ?? "active";
				const items = state.experiences.filter((experience) => status === "all" || experience.status === status);
				return {
					content: [{ type: "text", text: items.length ? items.map(formatExperience).join("\n\n") : `No ${status} experiences.` }],
					details: { action: "list", status, count: items.length },
				};
			}
			if (!params.text?.trim()) {
				return {
					content: [{ type: "text", text: "Error: text is required for action=propose or action=revise." }],
					details: { action: params.action, error: "missing text" },
				};
			}
			if (params.action === "revise") {
				const id = params.id?.trim();
				const target = id ? state.experiences.find((experience) => experience.id === id && !experience.revisionOf) : undefined;
				if (!id || !target) {
					return {
						content: [{ type: "text", text: "Error: action=revise requires an existing lesson id." }],
						details: { action: "revise", error: "missing target", id },
					};
				}
				const tags = Array.isArray(params.tags) && params.tags.length > 0 ? params.tags : target.tags;
				const notes = [`Revision of ${target.id}.`, params.sourceNote].filter(Boolean).join(" ");
				const experience = addExperience(state, params.text, "proposed", tags, `pi_prior revision tool ${toolCallId}`, notes, target.id);
				saveState(state);
				setStatus(ctx, state);
				pi.appendEntry("pi-prior-revise", { id: experience.id, revisionOf: target.id, text: experience.text, tags: experience.tags });
				return {
					content: [
						{
							type: "text",
							text: `Proposed revision ${experience.id} for ${target.id}. It will not be applied until /prior activate ${experience.id} or /prior review.`,
						},
					],
					details: { action: "revise", id: experience.id, revisionOf: target.id, status: experience.status },
				};
			}
			if (params.action !== "propose") {
				return {
					content: [{ type: "text", text: `Error: unsupported pi_prior action '${String(params.action)}'.` }],
					details: { action: params.action, error: "unsupported action" },
				};
			}
			const experience = addExperience(
				state,
				params.text,
				"proposed",
				Array.isArray(params.tags) ? params.tags : [],
				`pi_prior tool ${toolCallId}`,
				params.sourceNote,
			);
			saveState(state);
			setStatus(ctx, state);
			pi.appendEntry("pi-prior-propose", { id: experience.id, text: experience.text, tags: experience.tags });
			return {
				content: [{ type: "text", text: `Proposed ${experience.id}. It will not be injected until activated with /prior activate ${experience.id} or /prior review.` }],
				details: { action: "propose", id: experience.id, status: experience.status },
			};
		},
	});

	pi.registerCommand("prior", {
		description: "Manage pi-prior learned context prior",
		handler: async (args, ctx) => {
			const argv = parseArgs(args ?? "");
			const command = (argv[0] ?? "status").toLowerCase();
			const state = loadState();
			const notify = (message: string, kind: "info" | "success" | "warning" | "error" = "info") => ctx.ui.notify(message, kind);

			try {
				switch (command) {
					case "help":
					case "-h":
					case "--help":
						notify(usage(), "info");
						return;

					case "status":
					case "":
						setStatus(ctx, state);
						notify(summarizeState(state), "info");
						return;

					case "on":
					case "enable":
						state.enabled = true;
						saveState(state);
						setStatus(ctx, state);
						notify("pi-prior enabled", "success");
						return;

					case "off":
					case "disable":
						state.enabled = false;
						saveState(state);
						setStatus(ctx, state);
						notify("pi-prior disabled", "warning");
						return;

					case "list": {
						const status = (argv[1] ?? "active") as ExperienceStatus | "all";
						const valid = ["active", "proposed", "inactive", "rejected", "all"];
						if (!valid.includes(status)) {
							notify(`Unknown status '${status}'. Use one of: ${valid.join(", ")}`, "error");
							return;
						}
						const items = state.experiences.filter((experience) => status === "all" || experience.status === status);
						notify(items.length ? items.map(formatExperience).join("\n\n") : `No ${status} experiences.`, "info");
						return;
					}

					case "add":
					case "propose": {
						const raw = restAfterCommand(args ?? "");
						const { text, tags } = parseTaggedText(raw);
						if (!text) {
							notify(`Usage: /prior ${command} [#tag ...] <lesson>`, "error");
							return;
						}
						const status: ExperienceStatus = command === "add" ? "active" : "proposed";
						const experience = addExperience(state, text, status, tags, "manual-command");
						saveState(state);
						pi.appendEntry("pi-prior-manual", { action: command, id: experience.id, text: experience.text, tags });
						setStatus(ctx, state);
						notify(`${status === "active" ? "Added active" : "Proposed"} experience ${experience.id}`, "success");
						return;
					}

					case "revise": {
						const id = argv[1];
						const raw = (args ?? "").trim().replace(/^\S+\s+\S+\s*/, "").trim();
						const { text, tags } = parseTaggedText(raw);
						if (!id || !text) {
							notify("Usage: /prior revise <id> [#tag ...] <lesson>", "error");
							return;
						}
						const target = state.experiences.find((item) => item.id === id && !item.revisionOf);
						if (!target) {
							notify(`No matching experience for ${id}`, "warning");
							return;
						}
						const experience = addExperience(state, text, "proposed", tags.length > 0 ? tags : target.tags, "manual-revision", `Revision of ${target.id}.`, target.id);
						saveState(state);
						pi.appendEntry("pi-prior-manual", { action: "revise", id: experience.id, revisionOf: target.id, text: experience.text, tags: experience.tags });
						setStatus(ctx, state);
						notify(`Proposed revision ${experience.id} for ${target.id}. Use /prior activate ${experience.id} or /prior review to apply it.`, "success");
						return;
					}

					case "edit": {
						const id = argv[1];
						const raw = (args ?? "").trim().replace(/^\S+\s+\S+\s*/, "").trim();
						const { text, tags } = parseTaggedText(raw);
						if (!id || !text) {
							notify("Usage: /prior edit <id> [#tag ...] <lesson>", "error");
							return;
						}
						const experience = state.experiences.find((item) => item.id === id);
						if (!experience) {
							notify(`No matching experience for ${id}`, "warning");
							return;
						}
						experience.text = text;
						if (tags.length > 0) experience.tags = tags;
						experience.updatedAt = nowIso();
						saveState(state);
						pi.appendEntry("pi-prior-manual", { action: "edit", id: experience.id, text: experience.text, tags: experience.tags });
						setStatus(ctx, state);
						notify(`Edited experience ${experience.id}`, "success");
						return;
					}

					case "activate":
					case "deactivate":
					case "reject":
					case "delete": {
						const id = argv[1];
						if (!id) {
							notify(`Usage: /prior ${command} <id|all>`, "error");
							return;
						}
						const targetStatus: ExperienceStatus | undefined =
							command === "activate" ? "active" : command === "deactivate" ? "inactive" : command === "reject" ? "rejected" : undefined;
						let changed = 0;
						if (command === "delete") {
							const before = state.experiences.length;
							state.experiences = state.experiences.filter((experience) => experience.id !== id);
							changed = before - state.experiences.length;
						} else {
							for (const experience of state.experiences) {
								if (experience.id === id || (id === "all" && command === "activate" && experience.status === "proposed")) {
									if (command === "activate") {
										if (!activateExperience(state, experience)) continue;
									} else {
										experience.status = targetStatus!;
										experience.updatedAt = nowIso();
									}
									changed += 1;
								}
							}
						}
						if (changed === 0) {
							notify(`No matching experience for ${id}`, "warning");
							return;
						}
						saveState(state);
						pi.appendEntry("pi-prior-manual", { action: command, id, changed });
						setStatus(ctx, state);
						notify(`${command} changed ${changed} experience(s)`, "success");
						return;
					}

					case "review": {
						const proposed = state.experiences.filter((experience) => experience.status === "proposed");
						if (proposed.length === 0) {
							notify("No proposed experiences to review.", "info");
							return;
						}
						let activated = 0;
						for (const experience of proposed) {
							const target = experience.revisionOf ? state.experiences.find((item) => item.id === experience.revisionOf) : undefined;
							const title = target ? `Apply revision ${experience.id} to ${target.id}?` : `Activate ${experience.id}?`;
							const body = target
								? `Current ${target.id}:\n${target.text}\n\nRevision ${experience.id}:\n${experience.text}\n\nTags: ${experience.tags.join(", ") || "none"}`
								: `${experience.text}\n\nTags: ${experience.tags.join(", ") || "none"}`;
							const ok = await ctx.ui.confirm(title, body);
							if (ok && activateExperience(state, experience)) activated += 1;
						}
						saveState(state);
						setStatus(ctx, state);
						notify(`Activated/applied ${activated}/${proposed.length} proposed experiences.`, activated ? "success" : "info");
						return;
					}

					case "score": {
						const outcome = argv[1] as ScoreOutcome | undefined;
						const again = argv.includes("--again");
						const replace = argv.includes("--replace");
						const usageText = "Usage: /prior score success|failure|partial [--again|--replace] [notes]";
						if (outcome !== "success" && outcome !== "failure" && outcome !== "partial") {
							notify(usageText, "error");
							return;
						}
						if (again && replace) {
							notify("Use either --again to append another score or --replace to rewrite the latest score, not both.", "error");
							return;
						}
						const trace = findLastTrace();
						if (!trace) {
							notify("No captured trace to score yet.", "warning");
							return;
						}
						const notes = argv.slice(2).filter((arg) => arg !== "--again" && arg !== "--replace").join(" ");
						const existingScores = readScoreRecords().filter((score) => score.traceId === trace.id);
						if (replace && existingScores.length === 0) {
							notify(`Trace ${trace.id} has no existing score to replace. Use /prior score ${outcome} [notes] to score it.`, "warning");
							return;
						}
						if (existingScores.length > 0 && !again && !replace) {
							notify(`Trace ${trace.id} is already scored. Use /prior score ${outcome} --again [notes] to append another label, or --replace [notes] to rewrite the latest label.`, "warning");
							return;
						}
						if (existingScores.length > 0 && replace) {
							const replacement = replaceLatestTraceScore(state, trace, outcome, notes);
							if (!replacement) {
								notify(`Could not find a score record to replace for trace ${trace.id}.`, "warning");
								return;
							}
							saveState(state);
							setStatus(ctx, state);
							pi.appendEntry("pi-prior-score", replacement.record);
							notify(`Replaced score ${replacement.replaced.id} for trace ${trace.id} with ${outcome}. New score id ${replacement.record.id}; recomputed ${replacement.recomputedCount} affected lesson(s).`, "success");
							return;
						}
						const scored = scoreTrace(state, trace, outcome, notes);
						saveState(state);
						setStatus(ctx, state);
						pi.appendEntry("pi-prior-score", scored.record);
						notify(`Scored trace ${trace.id} as ${outcome}. Updated ${scored.updatedCount} injected experience(s).`, "success");
						return;
					}

					case "learn": {
						const dryRun = argv.includes("--dry-run");
						const markExisting = argv.includes("--mark-existing") || argv.includes("--baseline");
						const includeLearned = argv.includes("--include-learned") || argv.includes("--again");
						const markCount = argv.includes("all") ? Number.MAX_SAFE_INTEGER : Number(argv.find((arg) => /^\d+$/.test(arg)) ?? Number.MAX_SAFE_INTEGER);
						if (markExisting) {
							const count = Number.isFinite(markCount) ? markCount : Number.MAX_SAFE_INTEGER;
							const wouldMark = unlearnedScoreRecords(count).length;
							if (wouldMark === 0) {
								notify("No unlearned scored records to mark as learned.", "info");
								return;
							}
							if (dryRun) {
								notify(`Would mark ${wouldMark} existing scored record(s) as learned without starting a model turn.`, "info");
								return;
							}
							const record = markScoresLearned(count, "manual catch-up via /prior learn --mark-existing");
							notify(`Marked ${record.scoreIds.length} existing scored record(s) as learned without starting a model turn (${record.id}).`, "success");
							return;
						}
						const n = Number(argv.find((arg) => /^\d+$/.test(arg)) ?? "8");
						const packet = buildReflectionPacket(Number.isFinite(n) ? n : 8, includeLearned);
						if (packet.feedbackCount === 0) {
							const learning = learningStats();
							if (packet.budgetSkippedCount > 0) {
								notify(`No score records fit within the ${MAX_REFLECTION_PACKET_CHARS} character reflection packet budget. Try /prior learn 1 --dry-run or prune unusually large trace bodies. Packet: ${packet.path}`, "warning");
							} else if (learning.scores > 0 && !includeLearned) {
								notify("No unlearned scored records found. Use /prior learn [n] --include-learned to intentionally revisit score records already used for learning.", "warning");
							} else {
								notify("No scored traces found. Use /prior score success|failure|partial after a run first.", "warning");
							}
							return;
						}
						const missing = packet.missingTraceCount ? ` Warning: ${packet.missingTraceCount}/${packet.feedbackCount} scored trace body/bodies are missing, likely due to /prior prune scored.` : "";
						const skipped = packet.skippedLearnedCount && !includeLearned ? ` Skipped ${packet.skippedLearnedCount} score(s) already used for learning.` : "";
						const budget = packet.budgetSkippedCount ? ` Left ${packet.budgetSkippedCount} score(s) unlearned due to the reflection packet budget; rerun /prior learn with a smaller n later.` : "";
						if (dryRun) {
							notify(`Wrote reflection packet from ${packet.feedbackCount} scored trace(s) without starting a model turn or marking scores as learned.${skipped}${budget}${missing}\n${packet.path}`, "success");
							return;
						}
						await ctx.waitForIdle();
						pi.sendUserMessage(buildReflectionPrompt(packet.body));
						const learnRecord = recordLearnRun(packet);
						notify(`Started pi-prior reflection ${learnRecord.id} from ${packet.feedbackCount} scored trace(s); marked them as learned.${skipped}${budget}${missing} Packet: ${packet.path}`, "success");
						return;
					}

					case "prune": {
						const modeOrKeep = argv[1];
						const usageText = "Usage: /prior prune [n] | /prior prune unscored [n] | /prior prune scored <n>";
						if (modeOrKeep === undefined || /^\d+$/.test(modeOrKeep) || modeOrKeep === "unscored") {
							const rawKeep = modeOrKeep === "unscored" ? argv[2] : modeOrKeep;
							if (rawKeep !== undefined && !/^\d+$/.test(rawKeep)) {
								notify(usageText, "error");
								return;
							}
							const keep = rawKeep === undefined ? state.maxTraces : Math.max(0, Number(rawKeep));
							const result = pruneTraces(keep);
							setStatus(ctx, state);
							notify(`Pruned unscored traces: kept ${result.unscored}, removed ${result.unscoredRemoved}; scored preserved=${result.scored}. Limit=${keep}.`, result.removed ? "success" : "info");
							return;
						}
						if (modeOrKeep === "scored") {
							const rawKeep = argv[2];
							if (rawKeep === undefined || !/^\d+$/.test(rawKeep)) {
								notify(usageText, "error");
								return;
							}
							const keep = Math.max(0, Number(rawKeep));
							const result = pruneScoredTraces(keep);
							setStatus(ctx, state);
							notify(`Hard-pruned scored traces: kept ${result.scored}, removed ${result.scoredRemoved}; unscored preserved=${result.unscored}. Limit=${keep}.`, result.removed ? "success" : "warning");
							return;
						}
						notify(usageText, "error");
						return;
					}

					case "export": {
						const out = argv[1] ? resolve(process.cwd(), argv[1]) : join(STATE_DIR, `prior-export-${Date.now()}.json`);
						ensureDir(dirname(out));
						writeFileSync(out, `${JSON.stringify(state, null, 2)}\n`, "utf8");
						notify(`Exported pi-prior state to ${out}`, "success");
						return;
					}

					case "import": {
						const path = argv[1] ? resolve(process.cwd(), argv[1]) : undefined;
						const mode = argv[2] ?? "merge";
						if (!path || !existsSync(path) || (mode !== "merge" && mode !== "replace")) {
							notify("Usage: /prior import <path> [merge|replace]", "error");
							return;
						}
						const imported = normalizeState(JSON.parse(readFileSync(path, "utf8")));
						if (mode === "replace") {
							saveState(imported);
							setStatus(ctx, imported);
							notify(`Replaced pi-prior state from ${path}`, "success");
							return;
						}
						let added = 0;
						const existing = new Set(state.experiences.map((experience) => experience.text.trim().toLowerCase()));
						for (const experience of imported.experiences) {
							const key = experience.text.trim().toLowerCase();
							if (existing.has(key)) continue;
							addExperience(state, experience.text, experience.status, experience.tags, `import:${path}`, experience.notes);
							existing.add(key);
							added += 1;
						}
						saveState(state);
						setStatus(ctx, state);
						notify(`Imported ${added} new experience(s) from ${path}`, "success");
						return;
					}

					case "config": {
						const key = argv[1];
						const value = argv[2];
						let pruneResult: ReturnType<typeof pruneTraces> | undefined;
						if (key === "maxItems" && value && /^\d+$/.test(value)) state.maxItems = Math.max(1, Number(value));
						else if (key === "maxChars" && value && /^\d+$/.test(value)) state.maxChars = Math.max(400, Number(value));
						else if (key === "maxTraces" && value && /^\d+$/.test(value)) {
							state.maxTraces = Math.max(1, Number(value));
							pruneResult = pruneTraces(state.maxTraces);
						} else if (key === "minOverlap" && value && /^\d+$/.test(value)) state.minOverlap = Math.max(0, Number(value));
						else if (key === "autoCapture" && (value === "on" || value === "off")) state.autoCapture = value === "on";
						else if (key === "providerDebug" && (value === "on" || value === "off")) state.providerDebug = value === "on";
						else {
							notify("Usage: /prior config maxItems <n> | maxChars <n> | maxTraces <n> | minOverlap <n> | autoCapture on|off | providerDebug on|off", "error");
							return;
						}
						saveState(state);
						setStatus(ctx, state);
						const pruneMessage = pruneResult ? `; pruned unscored traces kept ${pruneResult.unscored}, removed ${pruneResult.unscoredRemoved}; scored preserved=${pruneResult.scored}` : "";
						notify(`Updated config ${key}=${value}${pruneMessage}`, "success");
						return;
					}

					case "path":
						notify(`state=${STATE_PATH}\ntraces=${TRACE_PATH}\nscores=${SCORE_PATH}\nlearns=${LEARN_PATH}\nreflection=${REFLECTION_DIR}`, "info");
						return;

					default:
						notify(`Unknown /prior command '${command}'.\n\n${usage()}`, "error");
						return;
				}
			} catch (error) {
				notify(`pi-prior error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
