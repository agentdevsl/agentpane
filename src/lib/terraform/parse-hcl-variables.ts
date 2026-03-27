export interface ParsedHclVariable {
  name: string;
  type: string;
  normalizedType: VariableType;
  description: string | null;
  default: string | null;
  sensitive: boolean;
  required: boolean;
}

export type VariableType = 'string' | 'number' | 'bool' | 'list' | 'map' | 'object' | 'unknown';

export interface SmartWidget {
  kind: 'select' | 'switch' | 'text';
  options?: string[];
  placeholder?: string;
}

/**
 * Extracts variable blocks from HCL code using brace-counting.
 */
export function parseHclVariables(code: string): ParsedHclVariable[] {
  const variables: ParsedHclVariable[] = [];
  const variablePattern = /variable\s+"([^"]+)"\s*\{/g;
  let match: RegExpExecArray | null;

  for (match = variablePattern.exec(code); match !== null; match = variablePattern.exec(code)) {
    const name = match[1] ?? '';
    const startIndex = match.index + match[0].length;
    let depth = 1;
    let i = startIndex;

    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }

    const body = code.slice(startIndex, i - 1);

    const typeRaw = extractAttribute(body, 'type');
    const description = extractStringAttribute(body, 'description');
    const defaultVal = extractAttribute(body, 'default');
    const sensitive = extractAttribute(body, 'sensitive') === 'true';

    variables.push({
      name,
      type: typeRaw ?? 'string',
      normalizedType: normalizeVariableType(typeRaw ?? 'string'),
      description,
      default: defaultVal,
      sensitive,
      required: defaultVal === null,
    });
  }

  return variables;
}

/**
 * Extracts a string-quoted attribute value from a variable body.
 */
function extractStringAttribute(body: string, attr: string): string | null {
  const match = body.match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`));
  return match?.[1] ?? null;
}

/**
 * Extracts an attribute value from a variable body.
 * Handles string values, bare values, and complex expressions with braces/brackets.
 */
function extractAttribute(body: string, attr: string): string | null {
  const match = body.match(new RegExp(`(?:^|\\n)\\s*${attr}\\s*=\\s*`));
  if (!match) return null;

  const afterEquals = body.slice((match.index ?? 0) + match[0].length);

  // String value
  if (afterEquals.startsWith('"')) {
    const endQuote = afterEquals.indexOf('"', 1);
    if (endQuote === -1) return null;
    return afterEquals.slice(1, endQuote);
  }

  // Complex value with braces or brackets
  if (afterEquals.startsWith('{') || afterEquals.startsWith('[')) {
    const open = afterEquals[0];
    const close = open === '{' ? '}' : ']';
    let depth = 1;
    let i = 1;
    while (i < afterEquals.length && depth > 0) {
      if (afterEquals[i] === open) depth++;
      else if (afterEquals[i] === close) depth--;
      i++;
    }
    return afterEquals.slice(0, i).trim();
  }

  // Bare value (bool, number, or type expression like list(string))
  // For type expressions, handle parentheses
  if (/^[a-z]/.test(afterEquals) && afterEquals.match(/^[a-z]+\s*\(/)) {
    let depth = 0;
    let i = 0;
    for (; i < afterEquals.length; i++) {
      if (afterEquals[i] === '(') depth++;
      else if (afterEquals[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return afterEquals.slice(0, i).trim();
  }

  // Simple bare value (true, false, number)
  const bareMatch = afterEquals.match(/^(\S+)/);
  return bareMatch?.[1] ?? null;
}

export function normalizeVariableType(raw: string): VariableType {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'string') return 'string';
  if (trimmed === 'number') return 'number';
  if (trimmed === 'bool') return 'bool';
  if (trimmed.startsWith('list')) return 'list';
  if (trimmed.startsWith('set')) return 'list';
  if (trimmed.startsWith('map')) return 'map';
  if (trimmed.startsWith('object')) return 'object';
  if (trimmed.startsWith('tuple')) return 'list';
  return 'unknown';
}

const AWS_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'];
const ENVIRONMENTS = ['production', 'staging', 'development'];
const INSTANCE_TYPES = ['t3.micro', 't3.small', 't3.medium', 't3.large', 'm5.large'];

export function inferSmartWidget(v: ParsedHclVariable): SmartWidget | null {
  const name = v.name.toLowerCase();

  if (v.normalizedType === 'bool') {
    return { kind: 'switch' };
  }

  if (name.includes('region')) {
    return { kind: 'select', options: AWS_REGIONS };
  }

  if (name.includes('environment') || name.endsWith('_env') || name === 'env') {
    return { kind: 'select', options: ENVIRONMENTS };
  }

  if (name.includes('instance_type')) {
    return { kind: 'select', options: INSTANCE_TYPES };
  }

  if (name.includes('cidr') || name.includes('subnet')) {
    return { kind: 'text', placeholder: '10.0.0.0/16' };
  }

  return null;
}
