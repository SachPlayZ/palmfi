"use client";

import { use } from "react";
import { IncidentView } from "@/components/vault/incident";

export default function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <IncidentView id={id} />;
}
