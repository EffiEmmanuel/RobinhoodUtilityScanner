// bs58@4 ships no type declarations of its own (the @types/bs58 stub is
// deprecated and targets bs58@5+'s different API shape) — pinned to 4.x here
// to match the version @solana/web3.js already depends on transitively.
declare module "bs58" {
  function encode(buffer: Uint8Array): string;
  function decode(input: string): Uint8Array;
  const _default: { encode: typeof encode; decode: typeof decode };
  export default _default;
}
