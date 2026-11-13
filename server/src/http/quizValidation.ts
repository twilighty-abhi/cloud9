// Quiz input validation + CSV/JSON import. Agent B.
import Papa from 'papaparse';
import { z } from 'zod';
import { DEFAULTS } from '../../../shared/model';
import type { EmailMode, ScoringMode, QuestionDef } from '../../../shared/model';
import type { QuizInput } from '../../../shared/api';
import { newId } from '../util/id';

export const LIMITS = {
  titleMax: 120,
  questionsMax: 100,
  textMax: 500,
  optionMax: 200,
  urlMax: 2000,
  timeMin: 5,
  timeMax: 300,
  pointsMin: 100,
  pointsMax: 5000,
} as const;

export const emailModeSchema = z.enum(['off', 'optional', 'required']);
export const scoringSchema = z.enum(['speed', 'flat']);

const imageUrlSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    const s = (v ?? '').trim();
    return s === '' ? null : s;
  })
  .refine((v) => v === null || (v.length <= LIMITS.urlMax && isHttpUrl(v)), { message: 'image URL must start with http:// or https://' });

export const questionInputSchema = z
  .object({
    text: z
      .string({ required_error: 'question text is required' })
      .transform((s) => s.trim())
      .pipe(z.string().min(1, 'question text is empty').max(LIMITS.textMax, `question text is longer than ${LIMITS.textMax} characters`)),
    imageUrl: imageUrlSchema,
    options: z
      .array(
        z
          .string()
          .transform((s) => s.trim())
          .pipe(z.string().min(1, 'option is empty').max(LIMITS.optionMax, `option is longer than ${LIMITS.optionMax} characters`)),
        { required_error: 'options are required' },
      )
      .min(2, 'needs at least 2 options')
      .max(4, 'has more than 4 options'),
    correctIndex: z.number({ required_error: 'correctIndex is required' }).int('correctIndex must be an integer'),
    timeLimitSec: z
      .number()
      .int('time limit must be a whole number of seconds')
      .min(LIMITS.timeMin, `time limit must be at least ${LIMITS.timeMin}s`)
      .max(LIMITS.timeMax, `time limit must be at most ${LIMITS.timeMax}s`)
      .optional()
      .default(DEFAULTS.timeLimitSec),
    pointsMax: z
      .number()
      .int('points must be a whole number')
      .min(LIMITS.pointsMin, `points must be at least ${LIMITS.pointsMin}`)
      .max(LIMITS.pointsMax, `points must be at most ${LIMITS.pointsMax}`)
      .optional()
      .default(DEFAULTS.pointsMax),
  })
  .superRefine((q, ctx) => {
    if (q.correctIndex < 0 || q.correctIndex >= q.options.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['correctIndex'], message: 'correct answer is out of range' });
    }
  });

export const quizInputSchema = z.object({
  title: z
    .string({ required_error: 'title is required' })
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'title is empty').max(LIMITS.titleMax, `title is longer than ${LIMITS.titleMax} characters`)),
  emailMode: emailModeSchema,
  scoring: scoringSchema,
  questions: z.array(questionInputSchema).min(1, 'quiz needs at least 1 question').max(LIMITS.questionsMax, `quiz has more than ${LIMITS.questionsMax} questions`),
});

export type ValidQuizInput = z.output<typeof quizInputSchema>;

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Human-readable message from a ZodError (first issue), with 1-based question numbers. */
export function zodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid input';
  const p = issue.path;
  if (p[0] === 'questions' && typeof p[1] === 'number') {
    let where = `Question ${p[1] + 1}`;
    if (p[2] === 'options' && typeof p[3] === 'number') where += `, option ${p[3] + 1}`;
    return `${where}: ${issue.message}`;
  }
  const field = p.length ? `${p.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

export function toQuestionDefs(input: ValidQuizInput): QuestionDef[] {
  return input.questions.map((q) => ({
    id: newId('qn'),
    text: q.text,
    imageUrl: q.imageUrl,
    options: q.options,
    correctIndex: q.correctIndex,
    timeLimitSec: q.timeLimitSec,
    pointsMax: q.pointsMax,
  }));
}

// ───────────────────────────── import ─────────────────────────────

export class ImportError extends Error {}

export const CSV_HEADER = ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct', 'time_sec', 'image_url'] as const;

export const TEMPLATE_CSV =
  [
    CSV_HEADER.join(','),
    'What is 2+2?,3,4,5,,B,20,',
    'Capital of Kerala?,Kochi,Thiruvananthapuram,Kozhikode,Thrissur,B,15,',
    '"Which planet is known as the ""Red Planet""?",Venus,Mars,Jupiter,Saturn,2,20,',
  ].join('\r\n') + '\r\n';

const OPTION_COLS = ['option_a', 'option_b', 'option_c', 'option_d'] as const;

function parseCorrect(raw: string): number | null {
  const s = raw.trim().toUpperCase();
  if (/^[A-D]$/.test(s)) return s.charCodeAt(0) - 65;
  if (/^[1-4]$/.test(s)) return Number(s) - 1;
  return null;
}

export function parseCsvQuestions(content: string): ValidQuizInput['questions'] {
  const text = content.replace(/^﻿/, '');
  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false });
  const rows = parsed.data;
  // locate header = first non-empty row
  let h = 0;
  const isBlank = (r: string[] | undefined) => !r || r.every((c) => (c ?? '').trim() === '');
  while (h < rows.length && isBlank(rows[h])) h++;
  if (h >= rows.length) throw new ImportError('The CSV file is empty');
  const header = rows[h].map((c) => (c ?? '').replace(/^﻿/, '').trim().toLowerCase());
  const col: Record<string, number> = {};
  header.forEach((name, i) => { if (name && !(name in col)) col[name] = i; });
  const missing = ['question', 'option_a', 'option_b', 'correct'].filter((c) => !(c in col));
  if (missing.length) {
    throw new ImportError(`Row ${h + 1}: header row must be "${CSV_HEADER.join(',')}" (missing ${missing.join(', ')})`);
  }
  const get = (r: string[], name: string) => (name in col ? (r[col[name]] ?? '') : '').trim();

  const out: ValidQuizInput['questions'] = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isBlank(r)) continue;
    const rowNo = i + 1;
    if (out.length >= LIMITS.questionsMax) throw new ImportError(`Row ${rowNo}: too many questions (max ${LIMITS.questionsMax})`);
    const qText = get(r, 'question');
    if (!qText) throw new ImportError(`Row ${rowNo}: question text is empty`);
    if (qText.length > LIMITS.textMax) throw new ImportError(`Row ${rowNo}: question text is longer than ${LIMITS.textMax} characters`);

    const rawOptions = OPTION_COLS.map((c) => get(r, c));
    const correctRaw = get(r, 'correct');
    if (!correctRaw) throw new ImportError(`Row ${rowNo}: correct answer is empty (use A–D or 1–4)`);
    const correctCol = parseCorrect(correctRaw);
    if (correctCol === null) throw new ImportError(`Row ${rowNo}: correct answer '${correctRaw.slice(0, 20)}' is not A–D or 1–4`);
    if (!rawOptions[correctCol]) {
      throw new ImportError(`Row ${rowNo}: correct answer '${correctRaw}' points to an empty option`);
    }
    // drop blanks and remap the correct index
    const options: string[] = [];
    let correctIndex = -1;
    rawOptions.forEach((o, idx) => {
      if (!o) return;
      if (idx === correctCol) correctIndex = options.length;
      options.push(o);
    });
    if (options.length < 2) throw new ImportError(`Row ${rowNo}: needs at least 2 non-empty options`);
    const long = options.findIndex((o) => o.length > LIMITS.optionMax);
    if (long >= 0) throw new ImportError(`Row ${rowNo}: option '${options[long].slice(0, 20)}…' is longer than ${LIMITS.optionMax} characters`);

    let timeLimitSec: number = DEFAULTS.timeLimitSec;
    const timeRaw = get(r, 'time_sec');
    if (timeRaw) {
      const n = Number(timeRaw);
      if (!Number.isInteger(n) || n < LIMITS.timeMin || n > LIMITS.timeMax) {
        throw new ImportError(`Row ${rowNo}: time_sec '${timeRaw.slice(0, 20)}' must be a whole number from ${LIMITS.timeMin} to ${LIMITS.timeMax}`);
      }
      timeLimitSec = n;
    }
    const img = get(r, 'image_url');
    if (img && (img.length > LIMITS.urlMax || !isHttpUrl(img))) throw new ImportError(`Row ${rowNo}: image_url must start with http:// or https://`);

    out.push({ text: qText, imageUrl: img || null, options, correctIndex, timeLimitSec, pointsMax: DEFAULTS.pointsMax });
  }
  if (out.length === 0) throw new ImportError('The CSV has no question rows');
  return out;
}

export interface ImportOptions { title: string; emailMode?: EmailMode; scoring?: ScoringMode }

/** Returns raw QuizInput (to be validated with quizInputSchema). Throws ImportError with a user-facing message. */
export function buildImport(format: 'csv' | 'json', content: string, opts: ImportOptions): QuizInput {
  const title = opts.title.trim();
  if (format === 'csv') {
    const questions = parseCsvQuestions(content);
    return { title, emailMode: opts.emailMode ?? 'optional', scoring: opts.scoring ?? 'speed', questions };
  }
  let data: unknown;
  try {
    data = JSON.parse(content.replace(/^﻿/, ''));
  } catch (e) {
    throw new ImportError(`Invalid JSON: ${(e as Error).message.slice(0, 120)}`);
  }
  if (Array.isArray(data)) {
    return { title, emailMode: opts.emailMode ?? 'optional', scoring: opts.scoring ?? 'speed', questions: data as QuizInput['questions'] };
  }
  if (data && typeof data === 'object' && Array.isArray((data as { questions?: unknown }).questions)) {
    const d = data as Partial<QuizInput>;
    return {
      title: title || (typeof d.title === 'string' ? d.title : ''),
      emailMode: opts.emailMode ?? d.emailMode ?? 'optional',
      scoring: opts.scoring ?? d.scoring ?? 'speed',
      questions: d.questions as QuizInput['questions'],
    };
  }
  throw new ImportError('JSON must be an array of questions or an object with a "questions" array');
}
