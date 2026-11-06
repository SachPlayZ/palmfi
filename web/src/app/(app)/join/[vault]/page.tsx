import { Join } from "@/components/join";

export const metadata = { title: "Join your team" };

export default async function JoinPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  return <Join id={vault} />;
}
