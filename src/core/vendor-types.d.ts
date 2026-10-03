declare module "mime-types" {
  const mime: { lookup(path: string): string | false };
  export default mime;
}
declare module "glob-to-regexp" {
  export default function glob(pattern: string): RegExp;
}
declare module "json-logic-js" {
  const logic: {
    apply(rule: unknown, data?: unknown): unknown;
    add_operation(name: string, operation: (...args: unknown[]) => unknown): void;
  };
  export default logic;
}
