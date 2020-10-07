'use strict';
const { Keccak } = require('sha3');

const leftPad = (num, size, char = '0') => {
  let s = num + '';

  while (s.length < size) s = char + s;

  return s;
};

const rightPad = (num, size, char = '0') => {
  let s = num + '';

  while (s.length < size) s = s + char;

  return s;
};

const convertToBitString = (number, bits) => leftPad(parseInt(number).toString(2), bits);

const convertToBytesString = (number, bits) => leftPad(parseInt(number).toString(16), bits >>> 2);

const bin2Hex = (b) => b.match(/.{4}/g).reduce((acc, i) => acc + parseInt(i, 2).toString(16), '');

const hex2Bin = (h) => h.split('').reduce((acc, i) => acc + ('000' + parseInt(i, 16).toString(2)).substr(-4, 4), '');

// NOTE: elements must array of buffers, preferably 32 bytes each
const hash = (elements) => {
  return new Keccak(256).update(Buffer.concat(elements)).digest();
};

const to32ByteBuffer = (number) => {
  return Buffer.from(leftPad(number.toString(16), 64), 'hex');
};

module.exports = {
  leftPad,
  rightPad,
  convertToBitString,
  convertToBytesString,
  bin2Hex,
  hex2Bin,
  hash,
  to32ByteBuffer,
};
