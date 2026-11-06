"use client";

import { use } from "react";
import { Dashboard } from "@/components/vault/dashboard";

export default function VaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Dashboard id={id} />;
}
