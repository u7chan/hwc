import { render } from "preact";
import { App } from "./App";
import { installInputModality } from "./focus";
import "./styles/tokens.css";
import "./styles/app.css";

installInputModality();

const root = document.getElementById("app");
if (root) render(<App />, root);
