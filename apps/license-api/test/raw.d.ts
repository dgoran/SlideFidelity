// Vite `?raw` imports (used by metrics.test.ts to run scripts/metrics.sql).
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
