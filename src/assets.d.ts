declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.txt?raw" {
  const text: string;
  export default text;
}
