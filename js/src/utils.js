const { Keccak } = require('sha3');

const leftPad = (num, size, char = '0') => {
  let s = num + '';

  while (s.length < size) s = char + s;

  return s;
};

const to32ByteBuffer = (number) => Buffer.from(leftPad(number.toString(16), 64), 'hex');

const from32ByteBuffer = (buffer) => buffer.readUInt32BE(28);

const hash = (buffer) => new Keccak(256).update(buffer).digest();

const hashPacked = (buffers) => hash(Buffer.concat(buffers));

const prefix = (value) => (value.startsWith('0x') ? value : '0x' + value);

const removePrefix = (value) => (value.startsWith('0x') ? value.slice(2) : value);

// Only accepts 4 types of values
// array of (hex strings, BigInts, or Buffers)
// Hex string, which will be returned 0x-prefixed (if not already)
// BigInt, which will be returned as 0x-prefixed 32-byte hex-string
// Buffer, which will be returned as 0x-prefixed hex string (size unchanged)
const toHex = (value) => {
  if (Array.isArray(value)) {
    return value.map((v) => toHex(v));
  }

  if (typeof value == 'string') return prefix(value);

  if (typeof value == 'bigint') return prefix(leftPad(value.toString(16), 64));

  if (Buffer.isBuffer(value)) return prefix(value.toString('hex'));

  console.log('toHex', value);

  throw Error('Invalid input type');
};

// Only accepts 4 types of values
// array of (hex strings, BigInts, or Buffers)
// Hex string, which will be returned as Buffer (size unchanged)
// BigInt, which will be returned as 32-byte Buffer
// Buffer, which will be returned unchanged
const toBuffer = (value) => {
  if (Array.isArray(value)) {
    return value.map((v) => toBuffer(v));
  }

  if (typeof value == 'string') return Buffer.from(removePrefix(value), 'hex');

  if (typeof value == 'bigint') return Buffer.from(leftPad(value.toString(16), 64), 'hex');

  if (Buffer.isBuffer(value)) return value;

  console.log('toBuffer', value);

  throw Error('Invalid input type');
};

// Only accepts 4 types of values
// array of (hex strings, BigInts, or Buffers)
// Hex string, which will be returned as a BigInt
// BigInt, which will be returned unchanged
// Buffer, which will be returned as a BigInt
const toBigInt = (value) => {
  if (Array.isArray(value)) {
    return value.map((v) => toBigInt(v));
  }

  if (typeof value == 'string') return BigInt(prefix(value));

  if (typeof value == 'bigint') return value;

  if (Buffer.isBuffer(value)) return BigInt(prefix(value.toString('hex')));

  console.log('toBigInt', value);

  throw Error('Invalid input type');
};

const compareHex = (a, b) => a.toLowerCase() === b.toLowerCase();

module.exports = {
  leftPad,
  to32ByteBuffer,
  from32ByteBuffer,
  hash,
  hashPacked,
  prefix,
  toHex,
  toBuffer,
  toBigInt,
  compareHex,
};
