// タブの切り替えだけ。プレビューの中で script が動くことを確かめるために置く。
const tabs = [...document.querySelectorAll(".tab")];
const panels = [...document.querySelectorAll(".panel")];

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const item of tabs) item.classList.toggle("is-selected", item === tab);
    for (const panel of panels) panel.hidden = panel.dataset.panel !== tab.dataset.panel;
  });
}
