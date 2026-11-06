import { RequestDetailTab } from "@/components/vault/tabs";

export async function generateMetadata({ params }: { params: Promise<{ rid: string }> }) {
  const { rid } = await params;
  return { title: `Request #${rid}` };
}

export default async function VaultRequestPage({ params }: { params: Promise<{ rid: string }> }) {
  const { rid } = await params;
  return <RequestDetailTab rid={rid} />;
}
