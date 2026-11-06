import { OrgProfile } from "@/components/public-pages";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return { title: decodeURIComponent(name) };
}

export default async function OrgPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <OrgProfile id={name} />;
}
