import React from 'react';
import logoShape from './icon.png';

/**
 * Natively logomark — the real brand logo (an "N" fused into a ring).
 *
 * `icon.png` is white-on-transparent, so on its own it vanishes on light
 * surfaces. Its ALPHA channel is the exact logo shape, so we use it as a CSS
 * mask over a `currentColor` fill: the mark keeps the true shape and takes
 * whatever text colour the caller sets (dark on light UI, light on dark UI,
 * `text-blue-500` for the brand blue, ...). No colour is baked into the image.
 */
export const NativelyLogoMark: React.FC<{
    size?: number;
    className?: string;
}> = ({ size = 18, className = '' }) => (
    <span
        aria-hidden="true"
        className={`inline-block shrink-0 ${className}`}
        style={{
            width: size,
            height: size,
            backgroundColor: 'currentColor',
            WebkitMaskImage: `url(${logoShape})`,
            maskImage: `url(${logoShape})`,
            WebkitMaskSize: 'contain',
            maskSize: 'contain',
            WebkitMaskRepeat: 'no-repeat',
            maskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
            maskPosition: 'center',
        }}
    />
);
