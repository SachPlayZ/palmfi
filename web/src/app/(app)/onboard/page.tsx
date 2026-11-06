import { Suspense } from "react";
import { OnboardWizard } from "@/components/onboard-wizard";

export const metadata = { title: "Create a vault" };

export default function OnboardPage() {
  return (
    <Suspense>
      <OnboardWizard />
    </Suspense>
  );
}
