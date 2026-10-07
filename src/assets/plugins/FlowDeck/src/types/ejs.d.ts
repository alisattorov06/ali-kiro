declare module 'ejs' {
  export function renderFile(path: string, data: unknown, options: unknown, callback: (err: Error | null, result?: string) => void): void;
  export function render(template: string, data: unknown, options?: unknown): string;
}