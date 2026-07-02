import "./index.css";
import { createRoot } from "react-dom/client";
import App from "./App";

// Initialize dark mode from system preference
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
if (prefersDark) document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(<App />);
