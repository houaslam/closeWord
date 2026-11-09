import Game from "../components/Game.jsx";
export default function GamePage() {
  return <Game />;
}
export async function getServerSideProps({ params }) {
  const path = "/" + (params?.path || []).join("/");
  if (
    !/^\/$|^\/multiplayer$|^\/multiplayer\/m\/[A-Z0-9]{6}$|^\/challenge$|^\/challenge\/[A-Z0-9]{6}$/i.test(
      path,
    )
  )
    return { notFound: true };
  return { props: {} };
}
