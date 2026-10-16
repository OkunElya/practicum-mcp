/** Vite's ?raw imports (tests read the extension's HTML pages). */
declare module '*?raw' {
  const text: string;
  export default text;
}
