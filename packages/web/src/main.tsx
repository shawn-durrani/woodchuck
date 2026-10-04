import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RenderOnly } from "./RenderOnly";
import { AuthGate } from "./components/AuthGate";
import "./styles.css";

// ?render=1 is the page the server photographs for a picture of the design.
// It runs on this computer, which the owner lock leaves open.
const params = new URLSearchParams(location.search);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {params.get("render") === "1" ? (
      <RenderOnly params={params} />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
);
