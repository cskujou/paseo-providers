import type { ComponentType, ReactElement, ReactNode, Ref } from "react";

export type StyleProp<T> =
  | T
  | readonly StyleProp<T>[]
  | null
  | undefined
  | false;

export type DimensionValue = number | `${number}%` | "auto";

export interface ViewStyle {
  flex?: number;
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  flexWrap?: "wrap" | "nowrap" | "wrap-reverse";
  flexGrow?: number;
  flexShrink?: number;
  alignItems?: "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
  alignSelf?:
    | "auto"
    | "flex-start"
    | "flex-end"
    | "center"
    | "stretch"
    | "baseline";
  justifyContent?:
    | "flex-start"
    | "flex-end"
    | "center"
    | "space-between"
    | "space-around"
    | "space-evenly";
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  padding?: DimensionValue;
  paddingHorizontal?: DimensionValue;
  paddingVertical?: DimensionValue;
  paddingTop?: DimensionValue;
  paddingBottom?: DimensionValue;
  paddingLeft?: DimensionValue;
  paddingRight?: DimensionValue;
  margin?: DimensionValue;
  marginHorizontal?: DimensionValue;
  marginVertical?: DimensionValue;
  marginTop?: DimensionValue;
  marginBottom?: DimensionValue;
  marginLeft?: DimensionValue;
  marginRight?: DimensionValue;
  width?: DimensionValue;
  height?: DimensionValue;
  minWidth?: DimensionValue;
  maxWidth?: DimensionValue;
  minHeight?: DimensionValue;
  maxHeight?: DimensionValue;
  backgroundColor?: string;
  borderColor?: string;
  borderRadius?: number;
  borderWidth?: number;
  borderLeftWidth?: number;
  borderRightWidth?: number;
  borderTopWidth?: number;
  borderBottomWidth?: number;
  opacity?: number;
  overflow?: "visible" | "hidden" | "scroll";
}

export interface TextStyle extends ViewStyle {
  color?: string;
  fontSize?: number;
  fontStyle?: "normal" | "italic";
  fontWeight?:
    | "normal"
    | "bold"
    | "100"
    | "200"
    | "300"
    | "400"
    | "500"
    | "600"
    | "700"
    | "800"
    | "900";
  fontFamily?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: "auto" | "left" | "right" | "center" | "justify";
}

export interface AccessibilityProps {
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: "none" | "button" | "link" | "header" | "text" | "summary";
  accessibilityState?: {
    disabled?: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
    busy?: boolean;
    expanded?: boolean;
  };
  testID?: string;
}

export interface ViewProps extends AccessibilityProps {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export interface TextProps extends AccessibilityProps {
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
  numberOfLines?: number;
  ellipsizeMode?: "head" | "middle" | "tail" | "clip";
  children?: ReactNode;
}

export interface PressableStateCallbackType {
  readonly pressed: boolean;
}

export interface PressableProps extends AccessibilityProps {
  onPress?: () => void;
  disabled?: boolean;
  hitSlop?:
    | number
    | { top?: number; bottom?: number; left?: number; right?: number };
  style?:
    | StyleProp<ViewStyle>
    | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
  children?:
    | ReactNode
    | ((state: PressableStateCallbackType) => ReactNode);
}

export interface ScrollViewProps extends ViewProps {
  contentContainerStyle?: StyleProp<ViewStyle>;
  horizontal?: boolean;
}

export interface FlatListProps<ItemT> extends ViewProps {
  data: readonly ItemT[] | null | undefined;
  renderItem: (info: { item: ItemT; index: number }) => ReactElement | null;
  keyExtractor?: (item: ItemT, index: number) => string;
}

export interface TextInputProps extends AccessibilityProps {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  placeholderTextColor?: string;
  editable?: boolean;
  multiline?: boolean;
  secureTextEntry?: boolean;
  onChangeText?: (text: string) => void;
  style?: StyleProp<TextStyle>;
}

export declare const View: ComponentType<ViewProps>;
export declare const Text: ComponentType<TextProps>;
export declare const Pressable: ComponentType<PressableProps>;
export declare class ScrollView {
  props: ScrollViewProps;
}
export declare class FlatList<ItemT = unknown> {
  props: FlatListProps<ItemT>;
  ref?: Ref<FlatList<ItemT>>;
}
export declare class TextInput {
  props: TextInputProps;
}
export declare const Platform: {
  readonly OS: "ios" | "android" | "web" | "macos" | "windows";
};
