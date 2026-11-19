import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';

export type ScrollMode = 'center' | 'top' | 'start' | 'none';

/** Rows register a handler so focusing a card scrolls the row horizontally. */
export const RowScrollContext = createContext<((el: HTMLElement) => void) | null>(null);

export function scrollPage(el: HTMLElement, mode: ScrollMode): void {
  if (mode === 'none') return;
  if (mode === 'top') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const r = el.getBoundingClientRect();
  const y = window.pageYOffset;
  let top: number;
  if (mode === 'center') top = y + r.top - (window.innerHeight - r.height) / 2;
  else top = y + r.top - window.innerHeight * 0.28; // 'start': keep row in the upper third, Netflix-style
  // Only scroll when the element isn't comfortably visible already, so small moves don't jitter.
  const margin = window.innerHeight * 0.12;
  if (mode === 'center' && r.top > margin && r.bottom < window.innerHeight - margin) return;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

interface Props {
  focusKey?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** How the page scrolls when this element gets focus from the remote/keyboard. */
  scroll?: ScrollMode;
  title?: string;
  onSelect?: () => void;
  onFocused?: () => void;
  onArrow?: (direction: string) => boolean;
  children?: ReactNode;
}

/**
 * Anything you can reach with the TV remote. Works with arrow keys + OK, the LG Magic Remote
 * pointer (hover focuses, click selects), and a desktop mouse/keyboard.
 */
export function Focusable({ focusKey, className, style, disabled, scroll = 'center', title, onSelect, onFocused, onArrow, children }: Props) {
  const rowScroll = useContext(RowScrollContext);
  const { ref, focused, focusSelf } = useFocusable<object, HTMLDivElement>({
    focusKey,
    focusable: !disabled,
    onEnterPress: () => onSelect?.(),
    onArrowPress: onArrow ? (dir) => onArrow(dir) : undefined,
    onFocus: (_layout, _props, details) => {
      const el = ref.current;
      if (el && !(details as { pointer?: boolean })?.pointer) {
        scrollPage(el, scroll);
        rowScroll?.(el);
      }
      onFocused?.();
    },
  });

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      title={title}
      aria-disabled={disabled || undefined}
      className={`focusable${focused ? ' is-focused' : ''}${disabled ? ' is-disabled' : ''}${className ? ' ' + className : ''}`}
      style={style}
      onMouseEnter={() => !disabled && !focused && focusSelf({ pointer: true } as never)}
      onClick={() => !disabled && onSelect?.()}
    >
      {children}
    </div>
  );
}

/** A group (row, menu, page section) that remembers which child was focused last. */
export function FocusGroup({
  focusKey,
  className,
  children,
  boundary,
}: {
  focusKey: string;
  className?: string;
  children: ReactNode;
  boundary?: boolean;
}) {
  const { ref, focusKey: key } = useFocusable<object, HTMLDivElement>({
    focusKey,
    trackChildren: true,
    saveLastFocusedChild: true,
    isFocusBoundary: boundary,
  });
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} className={className}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}
