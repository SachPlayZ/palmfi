import "./landing.css";
import { HeatTrail } from "@/components/site/fx";
import { Drift, Footer, Hero, HoldToSign, Nav, Network, Poster, States } from "@/components/site/landing";

export default function Landing() {
  return (
    <div className="site">
      <HeatTrail />
      <Nav />
      <main>
        <Hero />
        <Poster />
        <States />
        <Drift />
        <HoldToSign />
        <Network />
      </main>
      <Footer />
    </div>
  );
}
