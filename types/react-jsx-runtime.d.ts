import type { Key, ReactElement, ReactNode } from "react";

export namespace JSX {
  export type Element = ReactElement;
  export interface IntrinsicAttributes {
    key?: Key | null;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicElements {}
}

export const Fragment: (props: { children?: ReactNode }) => ReactElement;

export function jsx(
  type: unknown,
  props: Record<string, unknown>,
  key?: Key,
): ReactElement;

export function jsxs(
  type: unknown,
  props: Record<string, unknown>,
  key?: Key,
): ReactElement;
