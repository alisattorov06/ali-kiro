// CLI supported languages (25 total)
export const CLI_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'elixir',
  'go',
  'haskell',
  'html',
  'java',
  'javascript',
  'json',
  'kotlin',
  'lua',
  'nix',
  'php',
  'python',
  'ruby',
  'rust',
  'scala',
  'solidity',
  'swift',
  'typescript',
  'tsx',
  'yaml',
] as const;

export type CliLanguage = (typeof CLI_LANGUAGES)[number];

export interface CliMatch {
  file: string;
  range: {
    byteOffset: { start: number; end: number };
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  lines: string;
  text: string;
  replacement?: string;
  language: string;
}

export interface SgResult {
  matches: CliMatch[];
  totalMatches: number;
  truncated: boolean;
  truncatedReason?: 'timeout' | 'max_output_bytes' | 'max_matches';
  error?: string;
}
