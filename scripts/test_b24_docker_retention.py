import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("retention", pathlib.Path(__file__).with_name("b24-docker-retention.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
NOW = r.epoch("2026-09-15T12:00:00Z")


def container(name, image, day, running=False):
    return {"Id": name, "Name": "/" + name, "Image": image,
            "Created": f"2026-09-{day:02d}T00:00:00Z", "Config": {"Image": "b24-app:" + image},
            "State": {"Status": "running" if running else "exited", "Running": running,
                      "StartedAt": "2026-09-15T00:00:00Z", "FinishedAt": "2026-09-15T00:00:00Z", "ExitCode": 0},
            "Mounts": [], "NetworkSettings": {"Networks": {"erpnext_frappe_network": {}}}}


def image(name, tag=None):
    return {"Id": name, "RepoTags": [tag or "b24-app:" + name], "Created": "2026-09-01T00:00:00Z"}


class RetentionTests(unittest.TestCase):
    def test_only_audited_legacy_app_signature_allows_untagged_images(self):
        legacy = {"RepoTags": [], "Config": {"WorkingDir": "/app", "Cmd": ["node", "packages/backend/dist/server.js"],
                                               "ExposedPorts": {"8080/tcp": {}}}}
        self.assertTrue(r.owned_image(legacy))
        legacy["Config"]["Cmd"] = ["node", "other-service.js"]
        self.assertFalse(r.owned_image(legacy))

    def test_transient_job_disappearing_retries_snapshot(self):
        values = [SimpleNamespace(stdout="old job"), SimpleNamespace(returncode=1, stdout="[]"),
                  SimpleNamespace(stdout="old"), SimpleNamespace(returncode=0, stdout='[{"Id":"old"}]')]
        with patch.object(r, "run", side_effect=values), patch.object(r.time, "sleep"):
            self.assertEqual(r.inspect_all("container"), [{"Id": "old"}])

    def test_legacy_backend_is_owned(self):
        self.assertTrue(r.owned("b24-backend:e4a43d6"))
        self.assertFalse(r.owned("frappe/erpnext:v16.22.0"))

    def test_docker_nanosecond_timestamps(self):
        self.assertAlmostEqual(r.epoch("2026-09-15T03:58:49.539873372Z"),
                               r.epoch("2026-09-15T03:58:49.539873Z"))

    def setUp(self):
        self.cs = [container("b24-backend", "live", 15, True),
                   container("b24-backend-prev-new", "new", 14),
                   container("b24-backend-prev-mid", "mid", 13),
                   container("b24-backend-prev-old", "old", 12)]
        self.ims = [image(x) for x in ("live", "new", "mid", "old", "tilda", "catalog", "unused")]

    def plan(self):
        return r.plan(self.cs, self.ims, {"tilda", "catalog"}, NOW)

    def test_keeps_two_rollbacks_running_and_scheduled_images(self):
        _, keep, remove, images = self.plan()
        self.assertEqual([c["Image"] for c in keep], ["new", "mid"])
        self.assertEqual([c["Image"] for c in remove], ["old"])
        self.assertEqual({i["Id"] for i in images}, {"old", "unused"})

    def test_failed_and_duplicate_versions_are_not_extra_rollbacks(self):
        duplicate = container("b24-backend-prev-duplicate", "new", 15)
        failed = container("b24-backend-prev-failed", "failed", 15)
        failed["State"]["ExitCode"] = 1
        self.cs.extend([duplicate, failed])
        self.assertEqual([c["Image"] for c in self.plan()[1]], ["new", "mid"])

    def test_volumes_unrelated_containers_and_pins_protect_images(self):
        self.cs[-1]["Mounts"] = [{"Type": "volume"}]
        self.cs.append(container("unrelated-job", "unused", 1))
        self.ims.append(image("pinned"))
        self.ims[-1]["Config"] = {"Labels": {"b24.retention.keep": "true"}}
        self.assertEqual(self.plan()[2:], ([], []))

    def test_running_old_version_and_recent_build_are_preserved(self):
        self.cs[-1]["State"].update(Running=True, Status="running")
        self.ims[-1]["Created"] = "2026-09-15T11:59:00Z"
        self.assertEqual(self.plan()[2:], ([], []))

    def test_image_shared_with_another_repository_is_preserved(self):
        self.ims[-1]["RepoTags"].append("other-service:latest")
        self.assertNotIn("unused", [i["Id"] for i in self.plan()[3]])

    def test_unhealthy_or_recent_backend_aborts(self):
        original = copy.deepcopy(self.cs[0])
        for change in ("stopped", "network", "recent"):
            self.cs[0] = copy.deepcopy(original)
            if change == "stopped":
                self.cs[0]["State"]["Running"] = False
            elif change == "network":
                self.cs[0]["NetworkSettings"]["Networks"] = {}
            else:
                self.cs[0]["State"]["StartedAt"] = "2026-09-15T11:59:00Z"
            with self.assertRaises(RuntimeError):
                self.plan()


if __name__ == "__main__":
    unittest.main()
