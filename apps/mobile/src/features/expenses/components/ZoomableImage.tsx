import { useMemo, useRef } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native';

/** The scale range the viewer allows: never smaller than the frame, at most 5×. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

/**
 * Clamp a zoom factor into the viewer's range.
 *
 * Pure and exported so the boundary behaviour is unit-tested without a device: `MAX_ZOOM`
 * is reachable (the comparison is inclusive), and a non-finite ratio — a divide by a
 * zero-distance pinch — falls back to the fit scale instead of producing `NaN` on a
 * transform.
 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return MIN_ZOOM;
  if (value < MIN_ZOOM) return MIN_ZOOM;
  if (value > MAX_ZOOM) return MAX_ZOOM;
  return value;
}

/** The distance between the first two active touches, or `0` when there are fewer. */
export function touchDistance(touches: readonly { pageX: number; pageY: number }[]): number {
  const [first, second] = touches;
  if (first === undefined || second === undefined) return 0;
  return Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
}

/** Keep a pan offset inside a frame-relative limit. */
export function clampTranslation(value: number, limit: number): number {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

/**
 * A pinch-zoom and pan surface for one image — Roadmap T076's "viewer supports zoom, pan".
 *
 * ## The platform's own gesture stack, and no new dependency
 *
 * The app already ships an animation stack (react-native-reanimated is a dependency, and
 * the reanimated worklets runtime is pinned beside it), and T076's brief says to prefer it
 * and to avoid unnecessary viewer libraries. This uses React Native's **core** `Animated`
 * with `PanResponder`: no native module, nothing to add to a development build, and it
 * works in Expo Go. It provides exactly the two gestures the acceptance names.
 *
 * ## The transform is one `Animated.Image`
 *
 * Scale and translation are applied together, in that order, so panning after a zoom moves
 * the *image* rather than the unzoomed frame. The live numbers are held in a ref beside
 * their `Animated.Value`s because a gesture handler must read the value it is about to add
 * to: `Animated.Value.__getValue()` is private, and reading React state would be a render
 * behind the finger.
 *
 * ## Bounds are applied on release, not during the move
 *
 * Clamping mid-gesture makes a pinch feel like it is fighting the user. The move handler
 * tracks the gesture freely (up to a generous multiple), and the release handler springs
 * back into the allowed range — standard photo-viewer behaviour, and the reason `clampZoom`
 * is a pure exported function rather than inline arithmetic.
 */
export interface ZoomableImageProps {
  readonly uri: string;
  readonly accessibilityLabel?: string;
  /** A neutral backdrop, so a photo reads correctly in both themes. */
  readonly backdropClassName?: string;
}

export function ZoomableImage({
  uri,
  accessibilityLabel,
  backdropClassName = 'bg-inverse-surface',
}: ZoomableImageProps) {
  const scale = useRef(new Animated.Value(MIN_ZOOM)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  const current = useRef({ scale: MIN_ZOOM, x: 0, y: 0 });
  const gesture = useRef({ scale: MIN_ZOOM, x: 0, y: 0, pinch: 0 });

  const responder = useMemo(() => {
    const resetToFit = (): void => {
      current.current = { scale: MIN_ZOOM, x: 0, y: 0 };
      Animated.parallel([
        Animated.spring(scale, { toValue: MIN_ZOOM, useNativeDriver: true }),
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
      ]).start();
    };

    const settle = (): void => {
      const bounded = clampZoom(current.current.scale);
      current.current.scale = bounded;
      Animated.spring(scale, { toValue: bounded, useNativeDriver: true }).start();
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event: GestureResponderEvent) => {
        gesture.current = {
          scale: current.current.scale,
          x: current.current.x,
          y: current.current.y,
          pinch: touchDistance(event.nativeEvent.touches),
        };
      },
      onPanResponderMove: (event: GestureResponderEvent, state: PanResponderGestureState) => {
        const distance = touchDistance(event.nativeEvent.touches);

        if (distance > 0 && gesture.current.pinch > 0) {
          // Two fingers: scale relative to the distance this pinch started at.
          const next = clampZoom(gesture.current.scale * (distance / gesture.current.pinch));
          current.current.scale = next;
          scale.setValue(next);
          return;
        }

        if (current.current.scale > MIN_ZOOM) {
          // One finger once zoomed: pan, bounded so the image cannot leave the frame.
          const limit = 400 * current.current.scale;
          const nextX = clampTranslation(gesture.current.x + state.dx, limit);
          const nextY = clampTranslation(gesture.current.y + state.dy, limit);
          current.current.x = nextX;
          current.current.y = nextY;
          translateX.setValue(nextX);
          translateY.setValue(nextY);
        }
      },
      onPanResponderRelease: () => {
        if (current.current.scale <= MIN_ZOOM * 1.02) {
          resetToFit();
          return;
        }
        settle();
      },
      onPanResponderTerminate: () => {
        settle();
      },
    });
  }, [scale, translateX, translateY]);

  return (
    <View
      {...responder.panHandlers}
      className={`flex-1 items-center justify-center overflow-hidden ${backdropClassName}`}
    >
      <Animated.Image
        source={{ uri }}
        {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
        accessibilityRole="image"
        resizeMode="contain"
        style={{
          width: '100%',
          height: '100%',
          transform: [{ scale }, { translateX }, { translateY }],
        }}
      />
    </View>
  );
}
