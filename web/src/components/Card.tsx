import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: "div" | "section" | "aside" | "article";
  "aria-label"?: string;
}

/** The paper panel used throughout. */
export function Card({ children, className = "", style, as: Tag = "div", ...rest }: CardProps) {
  return (
    <Tag className={`card ${className}`.trim()} style={style} {...rest}>
      {children}
    </Tag>
  );
}
