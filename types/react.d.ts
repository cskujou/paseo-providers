export type Key = string | number | bigint;

export type ReactNode =
  | ReactElement
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Iterable<ReactNode>;

export interface ReactElement<
  Props = unknown,
  Type extends string | ComponentType<any> = string | ComponentType<any>,
> {
  type: Type;
  props: Props;
  key: string | null;
}

export type RefCallback<T> = (instance: T | null) => void;
export interface RefObject<T> {
  readonly current: T | null;
}
export type Ref<T> = RefCallback<T> | RefObject<T> | null | undefined;

export interface RefAttributes<T> {
  key?: Key | null;
  ref?: Ref<T>;
}

export interface FunctionComponent<Props = {}> {
  (props: Props): ReactNode;
  displayName?: string;
}

export interface ComponentClass<Props = {}> {
  new (props: Props): { render(): ReactNode };
  displayName?: string;
}

export type ComponentType<Props = {}> =
  | FunctionComponent<Props>
  | ComponentClass<Props>;

export interface ForwardRefExoticComponent<Props = {}> {
  (props: Props): ReactNode;
  displayName?: string;
}

export type SetStateAction<S> = S | ((prevState: S) => S);
export type Dispatch<A> = (value: A) => void;
export type DependencyList = readonly unknown[];
export type EffectCallback = () => void | (() => void);

export function useState<S>(
  initialState: S | (() => S),
): [S, Dispatch<SetStateAction<S>>];
export function useState<S = undefined>(): [
  S | undefined,
  Dispatch<SetStateAction<S | undefined>>,
];
export function useEffect(effect: EffectCallback, deps?: DependencyList): void;
export function useMemo<T>(factory: () => T, deps: DependencyList): T;
export function useCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  deps: DependencyList,
): T;
export function useRef<T>(initialValue: T): { current: T };
export function useSyncExternalStore<Snapshot>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot?: () => Snapshot,
): Snapshot;
