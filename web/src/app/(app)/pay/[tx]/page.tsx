import { Receipt } from "@/components/payments";

export const metadata = { title: "Receipt" };

export default async function ReceiptPage({ params }: { params: Promise<{ tx: string }> }) {
  const { tx } = await params;
  return <Receipt hash={tx} />;
}
