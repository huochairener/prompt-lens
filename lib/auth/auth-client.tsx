"use client";

import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";
import { ReactNode } from "react";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
  plugins: [anonymousClient()],
});

export const { useSession, signIn, signOut, signUp } = authClient;

// AuthProvider 组件
export function AuthProvider({ children }: { children: ReactNode }) {
  return children;
}
