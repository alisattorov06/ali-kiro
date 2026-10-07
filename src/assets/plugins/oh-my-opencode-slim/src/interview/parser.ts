import type {
  InterviewAssistantState,
  InterviewMessage,
  InterviewQuestion,
} from './types';
import { RawInterviewStateSchema, RawQuestionSchema } from './types';

const INTERVIEW_BLOCK_REGEX =
  /<interview_state>\s*([\s\S]*?)\s*<\/interview_state>/i;

function normalizeQuestion(
  value: unknown,
  index: number,
): InterviewQuestion | null {
  // Validate raw question object with Zod
  const result = RawQuestionSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const question =
    typeof result.data.question === 'string' ? result.data.question.trim() : '';
  if (!question) {
    return null;
  }

  const options = Array.isArray(result.data.options)
    ? result.data.options
        .filter((option): option is string => typeof option === 'string')
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    id:
      typeof result.data.id === 'string' && result.data.id.trim().length > 0
        ? result.data.id.trim()
        : `q-${index + 1}`,
    question,
    options,
    suggested:
      typeof result.data.suggested === 'string' &&
      result.data.suggested.trim().length > 0
        ? result.data.suggested.trim()
        : undefined,
  };
}

function repairJsonNewlines(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
      } else if (char === '\\') {
        result += char;
        escaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else {
        result += char;
      }
    } else {
      if (char === '"') {
        inString = true;
      }
      result += char;
    }
  }
  return result;
}

export function flattenMessage(message: InterviewMessage): string {
  return (message.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
}

export function buildFallbackState(
  messages: InterviewMessage[],
): InterviewAssistantState {
  const answerCount = messages.filter(
    (message) => message.info?.role === 'user',
  ).length;

  return {
    summary:
      answerCount > 0
        ? 'Interview in progress.'
        : 'Waiting for the first interview response.',
    questions: [],
  };
}

export function parseAssistantState(
  text: string,
  maxQuestions = 2,
): {
  state: InterviewAssistantState | null;
  error?: string;
} {
  const match = text.match(INTERVIEW_BLOCK_REGEX);
  if (!match) {
    return { state: null };
  }

  // Pre-process match[1] to repair common JSON escaping issues (e.g. unescaped newlines inside strings)
  let rawJson = match[1].trim();

  // A robust heuristic to escape literal carriage returns/newlines inside JSON string values
  // so JSON.parse doesn't throw "JSON Parse error: Expected '}'" or "Unexpected token".
  // This is safe because it only targets characters within quotes.
  try {
    // If it parses directly, great!
    JSON.parse(rawJson);
  } catch {
    // Try to normalize literal newlines inside string values:
    rawJson = repairJsonNewlines(rawJson);
  }

  try {
    const raw = JSON.parse(rawJson);
    // Validate raw LLM output with Zod before processing
    const parsed = RawInterviewStateSchema.parse(raw) as Record<
      string,
      unknown
    >;
    const summary =
      typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const title =
      typeof parsed.title === 'string' && parsed.title.trim().length > 0
        ? parsed.title.trim()
        : undefined;
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .map((value, index) => normalizeQuestion(value, index))
          .filter((value): value is InterviewQuestion => value !== null)
          .slice(0, maxQuestions)
      : [];

    return {
      state: {
        summary,
        title,
        questions,
      },
    };
  } catch (error) {
    return {
      state: null,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to parse interview state',
    };
  }
}

export function findLatestAssistantState(
  messages: InterviewMessage[],
  maxQuestions = 2,
): {
  state: InterviewAssistantState | null;
  latestAssistantError?: string;
} {
  let latestAssistantError: string | undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.info?.role !== 'assistant') {
      continue;
    }

    const parsed = parseAssistantState(flattenMessage(message), maxQuestions);
    if (parsed.state) {
      return {
        state: parsed.state,
        latestAssistantError,
      };
    }

    if (!latestAssistantError) {
      latestAssistantError = parsed.error ?? 'Missing <interview_state> block';
    }
  }

  return {
    state: null,
    latestAssistantError,
  };
}
