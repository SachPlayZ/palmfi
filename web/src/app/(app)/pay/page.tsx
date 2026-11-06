import { Suspense } from "react";
import { PayFlow } from "@/components/payments";

export const metadata = { title: "Pay" };

export default function PayPage() {
  return (
    <Suspense>
      <PayFlow />
    </Suspense>
  );
}
