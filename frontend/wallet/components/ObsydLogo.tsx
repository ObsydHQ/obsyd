export function ObsydMark({ size = 40 }: { size?: number }) {
  // An "umbra" — a soft blue crescent inside an obsidian disc.
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id="obsyd-bg" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#182333" />
          <stop offset="100%" stopColor="#0a0e14" />
        </radialGradient>
        <linearGradient id="obsyd-arc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5e8cff" />
          <stop offset="100%" stopColor="#1b45c4" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="22" fill="url(#obsyd-bg)" />
      <circle cx="24" cy="24" r="22" stroke="rgba(96,134,255,0.25)" strokeWidth="1" />
      <path
        d="M32 12a14 14 0 1 0 0 24 11 11 0 1 1 0-24z"
        fill="url(#obsyd-arc)"
      />
    </svg>
  );
}

export function ObsydLogo({ size = 26 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <ObsydMark size={size + 14} />
      <span
        style={{
          fontWeight: 800,
          fontSize: size,
          letterSpacing: "-0.03em",
          color: "var(--text)",
        }}
      >
        Obsyd
      </span>
    </span>
  );
}
