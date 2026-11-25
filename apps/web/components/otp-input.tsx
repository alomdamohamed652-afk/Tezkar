"use client";
import { useRef } from "react";

export function OtpInput({ value, onChange, error, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  error?: boolean;
  autoFocus?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  const fill = (start: number, raw: string) => {
    const nums = raw.replace(/\D/g, "").slice(0, 6 - start);
    if (!nums) return;
    const next = digits.slice();
    nums.split("").forEach((d, k) => { next[start + k] = d; });
    onChange(next.join("").slice(0, 6));
    const target = Math.min(start + nums.length, 5);
    refs.current[target]?.focus();
  };
  return (
    <div className={`otp-boxes${error ? " otp-boxes-error" : ""}`} dir="ltr" role="group" aria-label="كود التحقق المكوّن من 6 أرقام">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={el => { refs.current[i] = el; }}
          className="otp-box"
          value={d}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`الرقم ${i + 1} من 6`}
          autoFocus={autoFocus && i === 0}
          onChange={e => fill(i, e.target.value)}
          onKeyDown={e => {
            if (e.key === "Backspace") {
              e.preventDefault();
              if (digits[i]) {
                const next = digits.slice(); next[i] = ""; onChange(next.join(""));
              } else if (i > 0) {
                const next = digits.slice(); next[i - 1] = ""; onChange(next.join(""));
                refs.current[i - 1]?.focus();
              }
            } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
          }}
          onPaste={e => { e.preventDefault(); fill(0, e.clipboardData.getData("text")); }}
          onFocus={e => e.target.select()}
        />
      ))}
    </div>
  );
}
