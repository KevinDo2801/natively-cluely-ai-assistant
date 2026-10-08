interface VoiceBrandMarkIconProps {
    size?: number;
    className?: string;
}

/** Circled audio-bars mark used as the TopPill voice identity. */
export function VoiceBrandMarkIcon({
    size = 18,
    className,
}: VoiceBrandMarkIconProps) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            className={className}
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
            <rect x="7.75" y="9.5" width="2" height="5" rx="1" fill="currentColor" />
            <rect x="11" y="7" width="2" height="10" rx="1" fill="currentColor" />
            <rect x="14.25" y="9.5" width="2" height="5" rx="1" fill="currentColor" />
        </svg>
    );
}
