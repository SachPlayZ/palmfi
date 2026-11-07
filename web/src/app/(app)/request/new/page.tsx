import { Suspense } from "react";
import { RequestLink } from "@/components/payments";

export const metadata = { title: "Request a payment" };

export default function RequestNewPage() {
  return (
    <Suspense>
      <RequestLink />
    </Suspense>
  );
}
