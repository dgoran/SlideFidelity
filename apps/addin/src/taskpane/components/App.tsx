import { makeStyles, tokens } from "@fluentui/react-components";
import Header from "./Header";

const useStyles = makeStyles({
  root: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground1,
  },
});

export default function App() {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Header />
    </div>
  );
}
