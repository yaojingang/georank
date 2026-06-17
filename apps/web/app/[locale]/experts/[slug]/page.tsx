import {LegacyStaticPage, getLegacyMetadata} from '../../_legacy-page';

export const metadata = getLegacyMetadata('experts');

export default function ExpertDetailPage() {
  return <LegacyStaticPage page="experts" />;
}
