import { redirect } from "next/navigation";

/** Send lives in the Overview's Send modal now; keep old links working. */
export default async function VaultSendPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/vault/${id}?action=send`);
}
