import { describe, expect, it } from 'vitest';
import { parseJsLiteral } from '../src/content/ops/read';

describe('parseJsLiteral', () => {
  it('turns bare undefined into null but leaves strings alone', () => {
    const src = '{"a":undefined,"b":[undefined,1],"c":"undefined \\" undefined","undefinedKey":true}';
    expect(parseJsLiteral(src)).toEqual({ a: null, b: [null, 1], c: 'undefined " undefined', undefinedKey: true });
  });
});
