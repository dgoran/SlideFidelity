import { Image, makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
});

export default function Header() {
  const styles = useStyles();
  return (
    <header className={styles.header}>
      <Image width={24} height={24} src="assets/logo-filled.png" alt="" />
      <h1 className={styles.title}>SlideCheck</h1>
    </header>
  );
}
