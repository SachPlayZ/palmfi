import { VaultFrame } from "@/components/vault/frame";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const name = decodeURIComponent(id);
  return { title: { default: name, template: `%s · ${name} · palmfi` } };
}

export default async function VaultLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VaultFrame id={id}>{children}</VaultFrame>;
}
