/**
 * Look of a selectable card or chip in the Bots UI, the same as the desktop's radio cards (StandardPlanHandoffDialog):
 * the selected one gets a cream border and tint that stand out at least 3:1 on the dark surfaces; the others recede.
 */
export function choiceClass(selected: boolean): string {
  return selected
    ? 'border-primary/50 bg-primary/10 text-foreground hover:bg-primary/15 hover:text-foreground'
    : 'border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
}
