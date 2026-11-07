import { Suspense } from "react";
import { OnboardStart } from "@/components/onboard-start";

export const metadata = { title: "Open a vault" };

export default function OnboardPage() {
  return (
    <Suspense>
      <OnboardStart />
    </Suspense>
  );
}
