import { secret } from './ignored.js';

export function callee() {
  return 1;
}

export function target() {
  return callee();
}

export function caller() {
  return target();
}

export function revealSecret() {
  return secret;
}
