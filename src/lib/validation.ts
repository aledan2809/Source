/**
 * Server-side validation schemas and utilities
 */

export interface FormDataValidated {
  description: string;
  type: 'cumparare' | 'inchiriere';
  condition?: 'nou' | 'second-hand' | 'indiferent';
  zone: 'local' | 'regional' | 'global';
  zoneLocation?: string;
  budgetMin?: number;
  budgetMax?: number;
  currency: 'RON' | 'EUR' | 'USD' | 'GBP';
  quantity: number;
  unit: string;
  deadline: string;
  filePaths?: string[];
  clarificationRound?: number;
  previousQuestions?: string[];
  previousAnswers?: string[];
}

export interface ValidationError {
  field: string;
  message: string;
}

const VALID_TYPES = ['cumparare', 'inchiriere'] as const;
const VALID_CONDITIONS = ['nou', 'second-hand', 'indiferent'] as const;
const VALID_ZONES = ['local', 'regional', 'global'] as const;
const VALID_CURRENCIES = ['RON', 'EUR', 'USD', 'GBP'] as const;
// Display text variants that may come from stored results or refinements
const DEADLINE_DISPLAY_MAP: Record<string, string> = {
  'ASAP': 'ASAP',
  '1 săptămână': '1-saptamana', '1 saptamana': '1-saptamana', '1-saptamana': '1-saptamana',
  '2 săptămâni': '2-saptamani', '2 saptamani': '2-saptamani', '2-saptamani': '2-saptamani',
  '1 lună': '1-luna', '1 luna': '1-luna', '1-luna': '1-luna',
  '3 luni': '3-luni', '3-luni': '3-luni',
  'Fără urgență': 'fara-urgenta', 'fara urgenta': 'fara-urgenta', 'fara-urgenta': 'fara-urgenta',
};
const TYPE_DISPLAY_MAP: Record<string, string> = {
  'cumparare': 'cumparare', 'Cumpărare': 'cumparare', 'cumpărare': 'cumparare',
  'inchiriere': 'inchiriere', 'Închiriere': 'inchiriere', 'închiriere': 'inchiriere',
};
const CONDITION_DISPLAY_MAP: Record<string, string> = {
  'nou': 'nou', 'Nou': 'nou',
  'second-hand': 'second-hand', 'Second-hand': 'second-hand',
  'indiferent': 'indiferent', 'Indiferent': 'indiferent',
};
const ZONE_DISPLAY_MAP: Record<string, string> = {
  'local': 'local', 'Local': 'local',
  'regional': 'regional', 'Regional': 'regional',
  'global': 'global', 'Global': 'global',
};

function normalizeField<T extends string>(value: string, map: Record<string, string>, validValues: readonly T[]): T | null {
  const mapped = map[value];
  if (mapped && (validValues as readonly string[]).includes(mapped)) return mapped as T;
  if ((validValues as readonly string[]).includes(value)) return value as T;
  return null;
}

/**
 * Validate form data for interpret and generate endpoints
 */
export function validateFormData(data: unknown): {
  isValid: boolean;
  data?: FormDataValidated;
  errors?: ValidationError[]
} {
  if (!data || typeof data !== 'object') {
    return {
      isValid: false,
      errors: [{ field: 'root', message: 'Invalid data format' }]
    };
  }

  const input = data as Record<string, unknown>;
  const errors: ValidationError[] = [];

  // Required fields validation
  if (!input.description || typeof input.description !== 'string' || input.description.trim().length === 0) {
    errors.push({ field: 'description', message: 'Description is required' });
  }

  // Normalize type (accepts both enum and display text from stored results)
  const normalizedType = input.type && typeof input.type === 'string'
    ? normalizeField(input.type, TYPE_DISPLAY_MAP, VALID_TYPES)
    : null;
  if (!normalizedType) {
    errors.push({ field: 'type', message: 'Type must be "cumparare" or "inchiriere"' });
  }

  // Normalize zone
  const normalizedZone = input.zone && typeof input.zone === 'string'
    ? normalizeField(input.zone, ZONE_DISPLAY_MAP, VALID_ZONES)
    : null;
  if (!normalizedZone) {
    errors.push({ field: 'zone', message: 'Zone must be "local", "regional" or "global"' });
  }

  if (!input.currency || typeof input.currency !== 'string' || !(VALID_CURRENCIES as readonly string[]).includes(input.currency)) {
    errors.push({ field: 'currency', message: 'Currency must be RON, EUR, USD or GBP' });
  }

  if (!input.quantity || isNaN(Number(input.quantity)) || Number(input.quantity) <= 0) {
    errors.push({ field: 'quantity', message: 'Quantity must be a positive number' });
  }

  if (!input.unit || typeof input.unit !== 'string' || input.unit.trim().length === 0) {
    errors.push({ field: 'unit', message: 'Unit is required' });
  }

  // Normalize deadline (accepts display text like "1 săptămână" from stored results)
  const normalizedDeadline = input.deadline && typeof input.deadline === 'string'
    ? (DEADLINE_DISPLAY_MAP[input.deadline] || input.deadline.trim())
    : null;
  if (!normalizedDeadline || normalizedDeadline.length === 0) {
    errors.push({ field: 'deadline', message: 'Deadline is required' });
  }

  // Optional fields validation — normalize condition from display text
  const normalizedCondition = input.condition && typeof input.condition === 'string'
    ? normalizeField(input.condition, CONDITION_DISPLAY_MAP, VALID_CONDITIONS)
    : undefined;
  if (input.condition && !normalizedCondition) {
    errors.push({ field: 'condition', message: 'Condition must be "nou", "second-hand" or "indiferent"' });
  }

  if (input.budgetMin && (isNaN(Number(input.budgetMin)) || Number(input.budgetMin) < 0)) {
    errors.push({ field: 'budgetMin', message: 'Budget min must be a positive number or zero' });
  }

  if (input.budgetMax && (isNaN(Number(input.budgetMax)) || Number(input.budgetMax) < 0)) {
    errors.push({ field: 'budgetMax', message: 'Budget max must be a positive number or zero' });
  }

  if (input.clarificationRound && (isNaN(Number(input.clarificationRound)) || Number(input.clarificationRound) < 0)) {
    errors.push({ field: 'clarificationRound', message: 'Clarification round must be a non-negative number' });
  }

  if (input.filePaths && !Array.isArray(input.filePaths)) {
    errors.push({ field: 'filePaths', message: 'File paths must be an array' });
  }

  if (input.previousQuestions && !Array.isArray(input.previousQuestions)) {
    errors.push({ field: 'previousQuestions', message: 'Previous questions must be an array' });
  }

  if (input.previousAnswers && !Array.isArray(input.previousAnswers)) {
    errors.push({ field: 'previousAnswers', message: 'Previous answers must be an array' });
  }

  if (errors.length > 0) {
    return { isValid: false, errors };
  }

  // Type-safe validated data — using normalized values
  const validatedData: FormDataValidated = {
    description: input.description as string,
    type: normalizedType as 'cumparare' | 'inchiriere',
    zone: normalizedZone as 'local' | 'regional' | 'global',
    currency: input.currency as 'RON' | 'EUR' | 'USD' | 'GBP',
    quantity: Number(input.quantity),
    unit: input.unit as string,
    deadline: normalizedDeadline as string,
    condition: normalizedCondition as 'nou' | 'second-hand' | 'indiferent' | undefined,
    zoneLocation: input.zoneLocation as string | undefined,
    budgetMin: input.budgetMin ? Number(input.budgetMin) : undefined,
    budgetMax: input.budgetMax ? Number(input.budgetMax) : undefined,
    clarificationRound: input.clarificationRound ? Number(input.clarificationRound) : undefined,
    filePaths: input.filePaths as string[] | undefined,
    previousQuestions: input.previousQuestions as string[] | undefined,
    previousAnswers: input.previousAnswers as string[] | undefined,
  };

  return { isValid: true, data: validatedData };
}

/**
 * Rate limiting store (in-memory for MVP - should be Redis in production)
 */
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Simple rate limiting check
 */
export function checkRateLimit(ip: string, maxRequests: number = 5, windowMs: number = 60000): boolean {
  const now = Date.now();
  const key = ip;

  const current = rateLimitStore.get(key);

  if (!current || current.resetTime < now) {
    rateLimitStore.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (current.count >= maxRequests) {
    return false;
  }

  current.count++;
  return true;
}

/**
 * Clean up expired rate limit entries
 */
export function cleanupRateLimit(): void {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}

// Clean up every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRateLimit, 5 * 60 * 1000);
}